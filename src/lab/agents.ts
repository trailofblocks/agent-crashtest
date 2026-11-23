import { isRecord, randomHex } from "../util.js";
import type { Step, Workflow } from "./workflows.js";

/**
 * Scripted agents. No model: each one stands for a retry and recovery strategy that real agents
 * and agent frameworks use. They differ only in the policy below, so the lab can switch one part
 * of a strategy at a time.
 */
export interface AgentPolicy {
  /** Attempts per step, counting the first. `Infinity` retries until it works. */
  maxAttempts: number;
  /** Exponential backoff with jitter between attempts. `null` retries at once. */
  backoff: { baseMs: number; factor: number; maxMs: number } | null;
  /** Wait as long as a 429's Retry-After says, if it is at most `maxRetryAfterMs`. */
  honorRetryAfter: boolean;
  maxRetryAfterMs: number;
  /** Retry tools that aren't annotated `idempotentHint: true`. */
  retryUnsafe: boolean;
  /**
   * Dedup keys. `per-attempt`: a fresh key on every attempt (a common bug). `in-memory`: one key per
   * step, held in memory. `outbox`: one key per step, saved before the first attempt.
   */
  keys: "none" | "per-attempt" | "in-memory" | "outbox";
  /**
   * What the agent saves. `none`: nothing survives a crash, so a redelivered job starts over.
   * `after`: a checkpoint after each step. `before`: a step is marked attempted before its call,
   * and an attempted step is never run again (at-most-once).
   */
  progress: "none" | "after" | "before";
  /** Report an ambiguous outcome (a timeout, an unreadable reply) as unknown, not as failed. */
  reportUnknown: boolean;
  /** Give up on a call after this long. */
  timeoutMs: number;
}

const BACKOFF = { baseMs: 500, factor: 2, maxMs: 8_000 };
const COMMON = { maxRetryAfterMs: 60_000, timeoutMs: 30_000 };

export const POLICIES = {
  naive: {
    ...COMMON,
    maxAttempts: Infinity,
    backoff: null,
    honorRetryAfter: false,
    retryUnsafe: true,
    keys: "none",
    progress: "none",
    reportUnknown: false,
  },
  "no-retry": {
    ...COMMON,
    maxAttempts: 3,
    backoff: BACKOFF,
    honorRetryAfter: true,
    retryUnsafe: false,
    keys: "none",
    progress: "before",
    reportUnknown: false,
  },
  framework: {
    ...COMMON,
    maxAttempts: 3,
    backoff: BACKOFF,
    honorRetryAfter: true,
    retryUnsafe: true,
    keys: "none",
    progress: "after",
    reportUnknown: false,
  },
  idempotent: {
    ...COMMON,
    maxAttempts: 3,
    backoff: BACKOFF,
    honorRetryAfter: true,
    retryUnsafe: true,
    keys: "outbox",
    progress: "after",
    reportUnknown: true,
  },
} satisfies Record<string, AgentPolicy>;

export type CallResult = { kind: "reply"; isError: boolean; text: string } | { kind: "timeout" } | { kind: "error"; message: string };

export interface StepRecord {
  status: "done" | "failed" | "skipped" | "unknown" | "attempted";
  output?: Record<string, unknown>;
  detail?: string;
}

/** What the agent keeps in durable storage, if its policy saves anything. */
export interface Durable {
  steps: Record<string, StepRecord>;
  outbox: Record<string, { key: string }>;
}

/** The agent's only window on the world. The harness decides what is behind it. */
export interface AgentRuntime {
  call(server: string, tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<CallResult>;
  tools(server: string): Promise<Array<{ name: string; idempotent: boolean }>>;
  sleep(ms: number): Promise<void>;
  random(): number;
  load(): Promise<Durable | undefined>;
  save(state: Durable): Promise<void>;
}

export interface ReportLine {
  step: string;
  kind: string;
  ref: string;
  status: Exclude<StepRecord["status"], "attempted">;
  detail?: string;
}

/** What the agent tells the user it did. */
export interface AgentReport {
  steps: ReportLine[];
}

type Classified =
  | { kind: "ok"; output: Record<string, unknown> }
  | { kind: "rejected"; message: string }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "ambiguous"; why: string };

/** Read a tool reply the way an agent would: as text. */
export function classify(r: CallResult): Classified {
  if (r.kind === "timeout") return { kind: "ambiguous", why: "timed out" };
  if (r.kind === "error") return { kind: "ambiguous", why: r.message };
  let body: unknown;
  try {
    body = JSON.parse(r.text);
  } catch {
    return { kind: "ambiguous", why: "unreadable reply" };
  }
  if (!isRecord(body)) return { kind: "ambiguous", why: "unexpected reply" };
  if (r.isError) {
    if (body.error === "rate_limited") return { kind: "rate_limited", retryAfterMs: Number(body.retry_after_ms) || 0 };
    return { kind: "rejected", message: String(body.message ?? body.error ?? "error") };
  }
  if (typeof body.id !== "string") return { kind: "ambiguous", why: "reply without an id" };
  return { kind: "ok", output: body };
}

export class ScriptedAgent {
  constructor(private readonly p: AgentPolicy) {}

  private newKey(rt: AgentRuntime): string {
    return `ik_${randomHex(() => rt.random(), 8)}`;
  }

  private backoff(rt: AgentRuntime, attempt: number): number {
    const b = this.p.backoff;
    if (!b) return 0;
    const d = Math.min(b.maxMs, b.baseMs * b.factor ** (attempt - 1));
    return d / 2 + rt.random() * (d / 2);
  }

  async run(workflow: Workflow, rt: AgentRuntime): Promise<AgentReport> {
    const p = this.p;
    const saves = p.progress !== "none" || p.keys === "outbox";
    const state: Durable = (saves ? await rt.load() : undefined) ?? { steps: {}, outbox: {} };
    const persist = async () => {
      if (saves) await rt.save(state);
    };

    // Which tools are safe to retry, from their annotations.
    const safe = new Set<string>();
    if (!p.retryUnsafe) {
      for (const server of new Set(workflow.steps.map((s) => s.server))) {
        for (const t of await rt.tools(server)) if (t.idempotent) safe.add(`${server}/${t.name}`);
      }
    }

    const outputs: Record<string, Record<string, unknown>> = {};
    const memKeys = new Map<string, string>();

    for (const step of workflow.steps) {
      const rec = state.steps[step.id];
      if (rec?.status === "attempted") {
        // Resumed after a crash in the middle of this step. At-most-once: don't run it again.
        state.steps[step.id] = { status: p.reportUnknown ? "unknown" : "failed", detail: "interrupted by a crash" };
        await persist();
        continue;
      }
      if (rec) {
        if (rec.status === "done" && rec.output) outputs[step.id] = rec.output;
        continue;
      }
      if (step.needs?.some((n) => state.steps[n]?.status !== "done")) {
        state.steps[step.id] = { status: "skipped", detail: `needs ${step.needs.join(", ")}` };
        await persist();
        continue;
      }
      if (p.progress === "before") {
        state.steps[step.id] = { status: "attempted" };
        await persist();
      }

      let key: string | undefined;
      if (p.keys === "outbox") {
        key = state.outbox[step.id]?.key;
        if (!key) {
          key = this.newKey(rt);
          state.outbox[step.id] = { key };
          await persist();
        }
      } else if (p.keys === "in-memory") {
        key = memKeys.get(step.id) ?? this.newKey(rt);
        memKeys.set(step.id, key);
      }

      const result = await this.attempt(rt, step, step.args(outputs), key, safe);
      state.steps[step.id] = result;
      if (result.status === "done" && result.output) outputs[step.id] = result.output;
      await persist();
    }

    return {
      steps: workflow.steps.map((s) => {
        const r = state.steps[s.id];
        const status = !r || r.status === "attempted" ? "unknown" : r.status;
        return { step: s.id, kind: s.expect.kind, ref: s.expect.ref, status, ...(r?.detail ? { detail: r.detail } : {}) };
      }),
    };
  }

  private async attempt(rt: AgentRuntime, step: Step, args: Record<string, unknown>, key: string | undefined, safe: Set<string>): Promise<StepRecord> {
    const p = this.p;
    const retryable = p.retryUnsafe || safe.has(`${step.server}/${step.tool}`);
    for (let attempt = 1; ; attempt++) {
      const k = p.keys === "per-attempt" ? this.newKey(rt) : key;
      const callArgs = k ? { ...args, [step.keyField]: k } : args;
      const c = classify(await rt.call(step.server, step.tool, callArgs, p.timeoutMs));
      if (c.kind === "ok") return { status: "done", output: c.output };
      if (c.kind === "rejected") return { status: "failed", detail: c.message };

      const why = c.kind === "rate_limited" ? "rate limited" : c.why;
      // Only an ambiguous failure might have taken effect.
      const giveUp: StepRecord = { status: c.kind === "ambiguous" && p.reportUnknown ? "unknown" : "failed", detail: why };
      if (!retryable || attempt >= p.maxAttempts) return giveUp;

      let wait = this.backoff(rt, attempt);
      if (c.kind === "rate_limited" && p.honorRetryAfter) {
        if (c.retryAfterMs > p.maxRetryAfterMs) return giveUp;
        wait = Math.max(wait, c.retryAfterMs);
      }
      if (wait > 0) await rt.sleep(wait);
    }
  }
}
