import { z } from "zod";
import { isRecord, matchesGlob, seededRandom } from "./util.js";

export const FAULT_KINDS = [
  "lost_response",
  "lost_request",
  "duplicate",
  "slow",
  "garbled",
  "truncated",
  "rate_limit",
  "crash_before",
  "crash_after",
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

/** Faults that kill the agent. Only a harness that owns the agent's process can inject them. */
export const CRASH_FAULTS: readonly FaultKind[] = ["crash_before", "crash_after"];

export const FAULT_INFO: Record<FaultKind, { id: string; title: string; what: string }> = {
  lost_response: {
    id: "F1",
    title: "Lost response",
    what: "The call reaches the tool and takes effect. The reply never arrives, so the agent times out.",
  },
  lost_request: {
    id: "F2",
    title: "Lost request",
    what: "The call never reaches the tool, so the agent times out. From the agent's side this looks exactly like F1.",
  },
  duplicate: {
    id: "F3",
    title: "Duplicate delivery",
    what: "The tool receives the same call twice. The agent sees one reply.",
  },
  slow: {
    id: "F4",
    title: "Slow tool",
    what: "The tool takes 45 s. The agent gives up at 30 s, but the tool finishes the work anyway, after the agent's retry.",
  },
  garbled: {
    id: "F5",
    title: "Garbled result",
    what: "The call takes effect, and the reply arrives corrupted.",
  },
  truncated: {
    id: "F6",
    title: "Truncated result",
    what: "The call takes effect, and the reply arrives cut off halfway.",
  },
  rate_limit: {
    id: "F7",
    title: "Rate limit",
    what: "The tool's provider answers 429 with Retry-After for 60 s. Nothing runs while it is limited.",
  },
  crash_before: {
    id: "F8",
    title: "Crash before the call",
    what: "The agent's process dies as the call goes out. The call never reaches the tool.",
  },
  crash_after: {
    id: "F9",
    title: "Crash after the effect",
    what: "The call takes effect, then the agent's process dies before it reads the reply.",
  },
};

export const DEFAULT_SLOW_MS = 45_000;
export const DEFAULT_RATE_LIMIT_MS = 60_000;

const FaultKindSchema = z.enum(FAULT_KINDS);

const RuleSchema = z.object({
  /** Glob on `server/tool`. */
  tool: z.string().default("*"),
  /** Which matching call to fault, counting from 1. */
  call: z.number().int().positive().default(1),
  /** How many matching calls in a row, starting at `call`. */
  times: z.number().int().positive().default(1),
  fault: FaultKindSchema,
  /** `slow`: how long the tool takes. */
  delayMs: z.number().nonnegative().optional(),
  /** `rate_limit`: how long the provider stays limited. */
  windowMs: z.number().positive().optional(),
});

export const FaultPlanSchema = z.object({
  rules: z.array(RuleSchema).default([]),
  random: z
    .object({
      seed: z.number().int(),
      /** Chance that any one call gets a fault. */
      rate: z.number().min(0).max(1),
      faults: z.array(FaultKindSchema).min(1).optional(),
      tool: z.string().default("*"),
      /** Stop injecting after this many random faults. */
      max: z.number().int().nonnegative().optional(),
    })
    .optional(),
  slowMs: z.number().nonnegative().default(DEFAULT_SLOW_MS),
  rateLimitMs: z.number().positive().default(DEFAULT_RATE_LIMIT_MS),
});
export type FaultPlan = z.infer<typeof FaultPlanSchema>;
export type FaultPlanInput = z.input<typeof FaultPlanSchema>;

export function parsePlan(input: unknown): FaultPlan {
  return FaultPlanSchema.parse(input);
}

/** One `tools/call` as the injector saw it. */
export interface TraceEntry {
  /** Ordinal of this call among all tool calls the engine has seen, from 1. */
  n: number;
  /** Clock time when the call arrived. */
  t: number;
  server: string;
  tool: string;
  args: unknown;
  /** The fault injected on this call, if any. */
  fault: FaultKind | null;
  /** The provider was still rate-limited from an earlier fault, so the call was refused. */
  limited: boolean;
  /** How many copies reached the tool: 0, 1, or 2. */
  forwarded: number;
  /** What the agent got back. */
  outcome?: "delivered" | "dropped" | "garbled" | "truncated" | "rate_limited" | "crash" | "abandoned";
}

export interface Decision {
  fault: FaultKind | null;
  /** For `rate_limit` and calls inside its window: how long until the provider accepts calls again. */
  retryAfterMs?: number;
  /** For `slow`. */
  delayMs?: number;
}

/**
 * Decides, call by call, which fault to inject. One engine is shared by every proxy in a run, so
 * call numbers count across all tools and servers, in arrival order.
 */
export class FaultEngine {
  readonly plan: FaultPlan;
  readonly trace: TraceEntry[] = [];
  /** Faults injected so far. Calls refused inside a rate-limit window don't count again. */
  injected = 0;
  private matched: number[];
  private randomInjected = 0;
  private limitedUntil = new Map<string, number>();
  private rand: (() => number) | undefined;

  constructor(plan: FaultPlanInput | FaultPlan, opts: { allowCrash?: boolean } = {}) {
    this.plan = parsePlan(plan);
    this.matched = this.plan.rules.map(() => 0);
    if (this.plan.random) this.rand = seededRandom(this.plan.random.seed);
    if (!opts.allowCrash) {
      const kinds = [...this.plan.rules.map((r) => r.fault), ...(this.plan.random?.faults ?? [])];
      const crash = kinds.find((k) => CRASH_FAULTS.includes(k));
      if (crash) throw new Error(`fault "${crash}" needs a harness that owns the agent's process; a proxy can't inject it`);
    }
  }

  get calls(): number {
    return this.trace.length;
  }

  decide(server: string, tool: string, args: unknown, now: number): { entry: TraceEntry; decision: Decision } {
    const name = `${server}/${tool}`;
    const entry: TraceEntry = { n: this.trace.length + 1, t: now, server, tool, args, fault: null, limited: false, forwarded: 0 };
    this.trace.push(entry);

    // Every rule sees every call, so counts stay right even when an earlier rule fires.
    let fault: FaultKind | null = null;
    let rule: z.infer<typeof RuleSchema> | undefined;
    this.plan.rules.forEach((r, i) => {
      if (!matchesGlob(r.tool, name)) return;
      const k = ++this.matched[i]!;
      if (!fault && k >= r.call && k < r.call + r.times) {
        fault = r.fault;
        rule = r;
      }
    });

    // Two draws for every eligible call, used or not, so one call's outcome never shifts the next one's.
    const rnd = this.plan.random;
    let randomFault: FaultKind | null = null;
    if (rnd && this.rand && matchesGlob(rnd.tool, name)) {
      const roll = this.rand();
      const pick = this.rand();
      if (roll < rnd.rate) {
        const kinds = rnd.faults ?? FAULT_KINDS.filter((k) => !CRASH_FAULTS.includes(k));
        randomFault = kinds[Math.min(kinds.length - 1, Math.floor(pick * kinds.length))]!;
      }
    }

    const until = this.limitedUntil.get(server);
    if (until !== undefined && now < until) {
      entry.limited = true;
      return { entry, decision: { fault: null, retryAfterMs: until - now } };
    }

    if (!fault && randomFault && (rnd?.max === undefined || this.randomInjected < rnd.max)) {
      fault = randomFault;
      this.randomInjected++;
    }

    if (!fault) return { entry, decision: { fault: null } };
    entry.fault = fault;
    this.injected++;
    const decision: Decision = { fault };
    if (fault === "slow") decision.delayMs = rule?.delayMs ?? this.plan.slowMs;
    if (fault === "rate_limit") {
      const windowMs = rule?.windowMs ?? this.plan.rateLimitMs;
      this.limitedUntil.set(server, now + windowMs);
      decision.retryAfterMs = windowMs;
    }
    return { entry, decision };
  }
}

/** Keep the start and the end, scramble the middle: what a corrupted read looks like. */
export function garbleText(text: string): string {
  const a = Math.floor(text.length / 3);
  const b = Math.floor((2 * text.length) / 3);
  const middle = [...text.slice(a, b)].reverse().join("").replace(/[{}[\]":,]/g, "�");
  return `${text.slice(0, a)}\u0000${middle}${text.slice(b)}`;
}

/** The first half: what a reply cut off mid-stream looks like. */
export function truncateText(text: string): string {
  return text.slice(0, Math.ceil(text.length / 2));
}

/** Apply `garbled` or `truncated` to a tool result. Structured content is dropped, since it would be damaged too. */
export function damageResult(result: unknown, kind: "garbled" | "truncated"): unknown {
  if (!isRecord(result)) return result;
  const out: Record<string, unknown> = { ...result };
  delete out.structuredContent;
  if (Array.isArray(result.content)) {
    out.content = result.content.map((block) => {
      if (!isRecord(block) || typeof block.text !== "string") return block;
      return { ...block, text: kind === "garbled" ? garbleText(block.text) : truncateText(block.text) };
    });
  }
  return out;
}

/** The body of a 429 refusal, as JSON text in a tool error result. */
export function rateLimitBody(retryAfterMs: number): string {
  return JSON.stringify({
    error: "rate_limited",
    status: 429,
    message: `Too many requests. Retry after ${Math.ceil(retryAfterMs / 1000)} s.`,
    retry_after_ms: retryAfterMs,
  });
}
