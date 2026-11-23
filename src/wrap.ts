import { type Clock, RealClock } from "./clock.js";
import { damageResult, type FaultEngine, garbleText, truncateText } from "./faults.js";

export class ToolTimeoutError extends Error {
  override name = "ToolTimeoutError";
}

export class RateLimitError extends Error {
  override name = "RateLimitError";
  constructor(readonly retryAfterMs: number) {
    super(`rate limited: retry after ${Math.ceil(retryAfterMs / 1000)} s`);
  }
}

export interface WrapOptions {
  /** The tool's name. Fault rules match `server/name`. */
  name: string;
  /** Default `fn`. */
  server?: string;
  engine: FaultEngine;
  clock?: Clock;
  /**
   * The caller's timeout. A `slow` call longer than this throws ToolTimeoutError at the timeout and
   * still runs the function later, as a slow server would. Lost requests and responses also wait this
   * long before throwing. Default: throw at once.
   */
  timeoutMs?: number;
  /** Needed for crash faults: kill the agent. The wrapped call never settles afterwards. */
  onCrash?: () => void;
}

const NEVER = new Promise<never>(() => {});

function damage(value: unknown, kind: "garbled" | "truncated"): string {
  if (typeof value === "string") return kind === "garbled" ? garbleText(value) : truncateText(value);
  const asResult = damageResult(value, kind) as { content?: Array<{ text?: string }> };
  if (Array.isArray(asResult?.content) && asResult.content.some((b) => typeof b.text === "string")) {
    return asResult.content.map((b) => b.text ?? "").join("");
  }
  const text = JSON.stringify(value) ?? "";
  return kind === "garbled" ? garbleText(text) : truncateText(text);
}

/**
 * Inject faults into a plain async function, for agents whose tools aren't MCP. Same engine and
 * plan format as the proxy. A garbled or truncated result comes back as damaged text, which is
 * what a model would read. The first argument is recorded in the trace.
 */
export function withFaults<A extends unknown[], R>(fn: (...args: A) => Promise<R>, opts: WrapOptions): (...args: A) => Promise<R | string> {
  const clock = opts.clock ?? new RealClock();
  const server = opts.server ?? "fn";
  const waitTimeout = async () => {
    if (opts.timeoutMs) await clock.sleep(opts.timeoutMs);
  };
  const crash = () => {
    if (!opts.onCrash) throw new Error("a crash fault needs an onCrash handler");
    opts.onCrash();
    return NEVER;
  };

  return async (...args: A): Promise<R | string> => {
    const { entry, decision } = opts.engine.decide(server, opts.name, args[0], clock.now());
    const run = async () => {
      entry.forwarded++;
      return fn(...args);
    };
    const settle = (outcome: NonNullable<typeof entry.outcome>) => (entry.outcome = outcome);

    if (entry.limited || decision.fault === "rate_limit") {
      settle("rate_limited");
      throw new RateLimitError(decision.retryAfterMs ?? 0);
    }
    switch (decision.fault) {
      case "lost_request":
        settle("dropped");
        await waitTimeout();
        throw new ToolTimeoutError(`${opts.name} timed out`);
      case "lost_response":
        await run();
        settle("dropped");
        await waitTimeout();
        throw new ToolTimeoutError(`${opts.name} timed out`);
      case "duplicate": {
        const first = await run();
        await run().catch(() => undefined);
        settle("delivered");
        return first;
      }
      case "slow": {
        const delay = decision.delayMs ?? 0;
        if (opts.timeoutMs !== undefined && delay > opts.timeoutMs) {
          clock.setTimer(delay, () => void run().catch(() => undefined));
          await clock.sleep(opts.timeoutMs);
          settle("abandoned");
          throw new ToolTimeoutError(`${opts.name} timed out`);
        }
        await clock.sleep(delay);
        const r = await run();
        settle("delivered");
        return r;
      }
      case "garbled":
      case "truncated": {
        const r = await run();
        settle(decision.fault);
        return damage(r, decision.fault);
      }
      case "crash_before":
        settle("crash");
        return crash();
      case "crash_after":
        await run();
        settle("crash");
        return crash();
      default: {
        const r = await run();
        settle("delivered");
        return r;
      }
    }
  };
}
