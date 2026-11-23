import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import { type Clock, RealClock } from "./clock.js";
import { damageResult, type Decision, type FaultEngine, type FaultKind, rateLimitBody, type TraceEntry } from "./faults.js";
import { isRecord } from "./util.js";

export interface CrashInfo {
  server: string;
  tool: string;
  /** Call number, as in the trace. */
  n: number;
  point: "before" | "after";
}

export interface FaultProxyOptions {
  /** Name of the wrapped server. Fault rules match `server/tool`. */
  server: string;
  engine: FaultEngine;
  clock?: Clock;
  /** Time each tool call takes to reach the tool, in clock milliseconds. Default 0. */
  latencyMs?: number;
  /** Called for crash faults. The harness kills the agent; the proxy delivers nothing more for that call. */
  onCrash?: (info: CrashInfo) => void;
  /**
   * Close the server side when the client disconnects (default true). The lab turns this off, because
   * a crashed agent's server keeps running, and a slow call still in flight should still land.
   */
  closeUpstreamWithClient?: boolean;
  /** Called once a call's outcome is known. */
  onTrace?: (entry: TraceEntry) => void;
  log?: (line: string) => void;
}

type Id = string | number;

interface Msg {
  jsonrpc: "2.0";
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

interface CallCtx {
  entry: TraceEntry;
  decision: Decision;
  modern: boolean;
}

interface Pending {
  clientId: Id;
  /** `copy` is the second delivery of a duplicated call. Its reply is dropped. */
  role: "plain" | "primary" | "copy";
  call?: CallCtx;
}

const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const key = (id: Id) => `${typeof id}:${id}`;
const isRequest = (m: Msg) => typeof m.method === "string" && m.id !== undefined;
const isNotification = (m: Msg) => typeof m.method === "string" && m.id === undefined;
const isResponse = (m: Msg) => m.method === undefined && m.id !== undefined;

/**
 * A message-level MCP proxy that injects faults into `tools/call`. Every other message passes through
 * unchanged, so the handshake (`initialize` or `server/discover`) and every other feature work as
 * they would without it. Request ids are rewritten on the server side, so a duplicated call can
 * reach the server twice and the extra reply can be told apart and dropped.
 */
export class FaultProxy {
  private readonly clock: Clock;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private upIdsFor = new Map<string, string[]>();
  private cancelled = new Set<string>();
  private clientGone = false;
  private closed = false;
  /** Resolves when the proxy shuts down. */
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor(
    private readonly downstream: Transport,
    private readonly upstream: Transport,
    private readonly opts: FaultProxyOptions,
  ) {
    this.clock = opts.clock ?? new RealClock();
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  async start(): Promise<void> {
    this.upstream.onmessage = (m) => this.fromServer(m as Msg);
    this.downstream.onmessage = (m) => this.fromClient(m as Msg);
    this.downstream.onclose = () => {
      this.clientGone = true;
      if (this.opts.closeUpstreamWithClient !== false) void this.close();
    };
    this.upstream.onclose = () => void this.close();
    this.upstream.onerror = (e) => this.opts.log?.(`server transport error: ${e.message}`);
    this.downstream.onerror = (e) => this.opts.log?.(`client transport error: ${e.message}`);
    await this.upstream.start();
    await this.downstream.start();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([this.upstream.close(), this.downstream.close()]);
    this.resolveDone();
  }

  private toClient(msg: Msg): void {
    if (this.clientGone || this.closed) return;
    this.downstream.send(msg as JSONRPCMessage).catch((e: Error) => this.opts.log?.(`send to client failed: ${e.message}`));
  }

  private toServer(msg: Msg): void {
    if (this.closed) return;
    this.upstream.send(msg as JSONRPCMessage).catch((e: Error) => this.opts.log?.(`send to server failed: ${e.message}`));
  }

  private forward(msg: Msg, role: Pending["role"], call?: CallCtx): void {
    const upId = `ct-${++this.seq}`;
    this.pending.set(upId, { clientId: msg.id!, role, call });
    const k = key(msg.id!);
    this.upIdsFor.set(k, [...(this.upIdsFor.get(k) ?? []), upId]);
    if (call) call.entry.forwarded++;
    this.toServer({ ...msg, id: upId });
  }

  private fromClient(msg: Msg): void {
    if (isRequest(msg)) {
      if (msg.method === "tools/call") {
        this.handleCall(msg).catch((e: Error) => {
          this.opts.log?.(`tools/call failed in the proxy: ${e.message}`);
          this.toClient({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `crashtest proxy error: ${e.message}` } });
        });
      } else {
        this.forward(msg, "plain");
      }
      return;
    }
    if (isNotification(msg) && msg.method === "notifications/cancelled") {
      const requestId = msg.params?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        const k = key(requestId);
        this.cancelled.add(k);
        // Only cancel what the server has seen. A held call (F4) still reaches it later, as a slow
        // server would still be working on it.
        for (const upId of this.upIdsFor.get(k) ?? []) {
          if (this.pending.has(upId)) this.toServer({ ...msg, params: { ...msg.params, requestId: upId } });
        }
      }
      return;
    }
    // Other notifications, and replies to requests the server sent.
    this.toServer(msg);
  }

  private fromServer(msg: Msg): void {
    if (!isResponse(msg)) {
      this.toClient(msg);
      return;
    }
    const upId = String(msg.id);
    const p = this.pending.get(upId);
    if (!p) {
      this.opts.log?.(`dropped a reply for unknown request ${upId}`);
      return;
    }
    this.pending.delete(upId);
    const k = key(p.clientId);
    const rest = (this.upIdsFor.get(k) ?? []).filter((u) => u !== upId);
    if (rest.length) this.upIdsFor.set(k, rest);
    else this.upIdsFor.delete(k);

    if (p.role === "copy") return;
    if (p.call) {
      this.deliverCallReply(p, msg);
      return;
    }
    if (this.cancelled.has(k)) return;
    this.toClient({ ...msg, id: p.clientId });
  }

  private finish(entry: TraceEntry, outcome: NonNullable<TraceEntry["outcome"]>): void {
    entry.outcome = outcome;
    this.opts.onTrace?.(entry);
  }

  private crash(entry: TraceEntry, point: "before" | "after"): void {
    this.finish(entry, "crash");
    if (!this.opts.onCrash) throw new Error("a crash fault needs an onCrash handler");
    this.opts.onCrash({ server: this.opts.server, tool: entry.tool, n: entry.n, point });
  }

  private deliverCallReply(p: Pending, msg: Msg): void {
    const { entry, decision } = p.call!;
    const fault: FaultKind | null = decision.fault;
    if (fault === "lost_response") return this.finish(entry, "dropped");
    if (fault === "crash_after") return this.crash(entry, "after");
    const k = key(p.clientId);
    if (this.cancelled.has(k) || this.clientGone) return this.finish(entry, "abandoned");
    let out: Msg = { ...msg, id: p.clientId };
    if ((fault === "garbled" || fault === "truncated") && msg.result) {
      out = { ...out, result: damageResult(msg.result, fault) as Record<string, unknown> };
      this.finish(entry, fault);
    } else {
      this.finish(entry, "delivered");
    }
    this.toClient(out);
  }

  private async handleCall(msg: Msg): Promise<void> {
    const params = msg.params ?? {};
    const tool = typeof params.name === "string" ? params.name : "";
    const meta = params._meta;
    const modern = isRecord(meta) && meta[PROTOCOL_VERSION_META] !== undefined;
    const { entry, decision } = this.opts.engine.decide(this.opts.server, tool, params.arguments, this.clock.now());
    const ctx: CallCtx = { entry, decision, modern };

    if (this.opts.latencyMs) await this.clock.sleep(this.opts.latencyMs);

    if (entry.limited || decision.fault === "rate_limit") {
      this.finish(entry, "rate_limited");
      const result: Record<string, unknown> = { content: [{ type: "text", text: rateLimitBody(decision.retryAfterMs ?? 0) }], isError: true };
      // Clients on revision 2026-07-28 reject a result without `resultType`.
      if (modern) result.resultType = "complete";
      this.toClient({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    switch (decision.fault) {
      case "lost_request":
        this.finish(entry, "dropped");
        return;
      case "crash_before":
        this.crash(entry, "before");
        return;
      case "slow":
        await this.clock.sleep(decision.delayMs ?? 0);
        this.forward(msg, "primary", ctx);
        return;
      case "duplicate":
        this.forward(msg, "primary", ctx);
        this.forward(msg, "copy", ctx);
        return;
      default:
        this.forward(msg, "primary", ctx);
    }
  }
}
