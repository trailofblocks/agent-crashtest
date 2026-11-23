import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { SimClock } from "../clock.js";
import { FaultEngine, type FaultPlanInput, type TraceEntry } from "../faults.js";
import { type CheckResult, checkInvariants } from "../invariants.js";
import { type Effect, Ledger } from "../ledger.js";
import { FaultProxy } from "../proxy.js";
import { createSandboxServer } from "../sandbox/server.js";
import { SandboxWorld, type ServiceName } from "../sandbox/world.js";
import { seededRandom } from "../util.js";
import { type AgentReport, type AgentRuntime, type CallResult, type Durable, ScriptedAgent } from "./agents.js";
import type { Variant } from "./variants.js";
import { expectedEffects, type Workflow } from "./workflows.js";

export interface RunSpec {
  variant: Variant;
  workflow: Workflow;
  plan: FaultPlanInput;
  /** Seeds the agent's randomness: keys and backoff jitter. */
  seed?: number;
  /** The watchdog stops a run after this many tool calls. */
  maxCalls?: number;
  /** Give up after this many crashes. */
  maxCrashes?: number;
  /** Simulated time each tool call takes. */
  latencyMs?: number;
}

export interface RunRecord {
  variant: string;
  workflow: string;
  finished: boolean;
  stopped?: string;
  crashes: number;
  report?: AgentReport;
  effects: Effect[];
  trace: TraceEntry[];
  injected: number;
  /** Simulated milliseconds from start to finish. */
  elapsedMs: number;
}

export const DEFAULT_MAX_CALLS = 200;
export const DEFAULT_MAX_CRASHES = 5;
export const DEFAULT_LATENCY_MS = 100;

const NEVER = new Promise<never>(() => {});

/**
 * One incarnation of the agent's process. When it dies, everything it was waiting on stays pending
 * forever, as it would in a killed process: its code never runs again, and it can't write anything.
 */
class Life {
  dead = false;
  readonly death: Promise<{ kind: "crash" | "runaway" }>;
  private resolveDeath!: (v: { kind: "crash" | "runaway" }) => void;

  constructor() {
    this.death = new Promise((r) => (this.resolveDeath = r));
  }

  kill(kind: "crash" | "runaway"): void {
    if (this.dead) return;
    this.dead = true;
    this.resolveDeath({ kind });
  }

  guard<T>(p: Promise<T>): Promise<T> {
    if (this.dead) return NEVER;
    return new Promise<T>((resolve, reject) => {
      p.then(
        (v) => {
          if (!this.dead) resolve(v);
        },
        (e: unknown) => {
          if (!this.dead) reject(e);
        },
      );
    });
  }
}

export function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: unknown) => (typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
    .join("");
}

/** Run one agent through one workflow with one fault plan, on simulated time, in this process. */
export async function runInProcess(spec: RunSpec): Promise<RunRecord> {
  const maxCalls = spec.maxCalls ?? DEFAULT_MAX_CALLS;
  const maxCrashes = spec.maxCrashes ?? DEFAULT_MAX_CRASHES;
  const clock = new SimClock();
  const ledger = new Ledger();
  const world = new SandboxWorld(ledger, clock, { dedup: spec.variant.dedup });
  const engine = new FaultEngine(spec.plan, { allowCrash: true });
  const rand = seededRandom(spec.seed ?? 1);
  // The agent's database. It outlives every incarnation of the agent.
  let durable: string | undefined;
  const servers = [...new Set(spec.workflow.steps.map((s) => s.server))] as ServiceName[];
  const closers: Array<() => Promise<unknown>> = [];

  let crashes = 0;
  let finished = false;
  let stopped: string | undefined;
  let report: AgentReport | undefined;

  await clock.run(async () => {
    for (;;) {
      const life = new Life();
      const clients: Record<string, Client> = {};
      for (const name of servers) {
        const server = createSandboxServer(world, [name]);
        const [clientSide, proxyDown] = InMemoryTransport.createLinkedPair();
        const [proxyUp, serverSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        const proxy = new FaultProxy(proxyDown, proxyUp, {
          server: name,
          engine,
          clock,
          latencyMs: spec.latencyMs ?? DEFAULT_LATENCY_MS,
          closeUpstreamWithClient: false,
          onCrash: () => life.kill("crash"),
        });
        await proxy.start();
        const client = new Client({ name: "crashtest-lab-agent", version: "0.1.0" });
        await client.connect(clientSide);
        clients[name] = client;
        closers.push(
          () => proxy.close(),
          () => server.close(),
        );
      }

      const runtime: AgentRuntime = {
        call: async (server, tool, args, timeoutMs): Promise<CallResult> => {
          if (life.dead) return NEVER;
          if (engine.calls >= maxCalls) {
            life.kill("runaway");
            return NEVER;
          }
          const ac = new AbortController();
          const cancel = clock.setTimer(timeoutMs, () => ac.abort(new Error("timed out")));
          try {
            const r = await life.guard(clients[server]!.callTool({ name: tool, arguments: args }, { signal: ac.signal, timeout: 600_000 }));
            return { kind: "reply", isError: r.isError === true, text: textOf(r) };
          } catch (e) {
            if (ac.signal.aborted) return { kind: "timeout" };
            return { kind: "error", message: (e as Error).message };
          } finally {
            cancel();
          }
        },
        tools: async (server) => {
          const res = await life.guard(clients[server]!.listTools());
          return res.tools.map((t) => ({ name: t.name, idempotent: t.annotations?.idempotentHint === true }));
        },
        sleep: (ms) => life.guard(clock.sleep(ms)),
        random: () => rand(),
        load: async () => life.guard(Promise.resolve(durable === undefined ? undefined : (JSON.parse(durable) as Durable))),
        save: async (state) => {
          if (life.dead) return NEVER;
          durable = JSON.stringify(state);
        },
      };

      const agent = new ScriptedAgent(spec.variant.policy);
      const outcome = await Promise.race([agent.run(spec.workflow, runtime).then((r) => ({ kind: "done" as const, r })), life.death]);
      if (outcome.kind === "done") {
        report = outcome.r;
        finished = true;
        break;
      }
      // The process is gone, and so are its connections.
      await Promise.allSettled(Object.values(clients).map((c) => c.close()));
      if (outcome.kind === "runaway") {
        stopped = `stopped by the watchdog after ${maxCalls} tool calls`;
        break;
      }
      crashes++;
      if (crashes > maxCrashes) {
        stopped = `gave up after ${crashes} crashes`;
        break;
      }
      // Restart. An agent that saved nothing gets the job again and starts over.
    }
  });
  const elapsedMs = clock.now();
  // Calls still in flight (a slow tool the agent gave up on) land now.
  await clock.drain();
  await Promise.allSettled(closers.map((c) => c()));

  return {
    variant: spec.variant.id,
    workflow: spec.workflow.id,
    finished,
    ...(stopped ? { stopped } : {}),
    crashes,
    ...(report ? { report } : {}),
    effects: [...ledger.effects],
    trace: engine.trace.map((e) => ({ ...e })),
    injected: engine.injected,
    elapsedMs,
  };
}

export function check(record: RunRecord, workflow: Workflow, baselineCalls: number): CheckResult {
  return checkInvariants({
    expected: expectedEffects(workflow),
    effects: record.effects,
    trace: record.trace,
    finished: record.finished,
    stopped: record.stopped,
    report: record.report?.steps,
    baselineCalls,
    injected: record.injected,
  });
}
