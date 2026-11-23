// The proxy between the official MCP SDK client and the sandbox server, one fault at a time.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { SimClock } from "../src/clock.js";
import { FaultEngine, type FaultPlanInput } from "../src/faults.js";
import { Ledger } from "../src/ledger.js";
import { textOf } from "../src/lab/harness.js";
import { type CrashInfo, FaultProxy } from "../src/proxy.js";
import { createSandboxServer } from "../src/sandbox/server.js";
import { SandboxWorld } from "../src/sandbox/world.js";

interface Rig {
  clock: SimClock;
  ledger: Ledger;
  engine: FaultEngine;
  client: Client;
  crashes: CrashInfo[];
  /** Call create_charge with a simulated timeout, the way the lab's agents do. */
  charge(args?: Record<string, unknown>, timeoutMs?: number): Promise<{ text: string; isError: boolean; structured: unknown } | "timeout">;
  close(): Promise<void>;
}

async function rig(plan: FaultPlanInput, clientOptions?: ConstructorParameters<typeof Client>[1]): Promise<Rig> {
  const clock = new SimClock();
  const ledger = new Ledger();
  const world = new SandboxWorld(ledger, clock);
  const engine = new FaultEngine(plan, { allowCrash: true });
  const [clientSide, down] = InMemoryTransport.createLinkedPair();
  const [up, serverSide] = InMemoryTransport.createLinkedPair();
  // serveStdio over a given transport speaks both handshakes, as `crashtest serve` does.
  const server = serveStdio(() => createSandboxServer(world, ["payments"]), { transport: serverSide });
  const crashes: CrashInfo[] = [];
  const proxy = new FaultProxy(down, up, { server: "payments", engine, clock, latencyMs: 100, closeUpstreamWithClient: false, onCrash: (c) => crashes.push(c) });
  await proxy.start();
  const client = new Client({ name: "test", version: "1.0.0" }, clientOptions);
  await client.connect(clientSide);
  return {
    clock,
    ledger,
    engine,
    client,
    crashes,
    async charge(args = { customer: "cus_ada", amount_cents: 4900, reference: "inv_1" }, timeoutMs = 30_000) {
      const ac = new AbortController();
      const cancel = clock.setTimer(timeoutMs, () => ac.abort(new Error("timed out")));
      try {
        const r = await client.callTool({ name: "create_charge", arguments: args }, { signal: ac.signal, timeout: 600_000 });
        return { text: textOf(r), isError: r.isError === true, structured: r.structuredContent };
      } catch (e) {
        if (ac.signal.aborted) return "timeout";
        throw e;
      } finally {
        cancel();
      }
    },
    async close() {
      await client.close();
      await proxy.close();
      await server.close();
    },
  };
}

describe("proxy faults, against the SDK client and a real MCP server", () => {
  test("no fault: the reply passes through, tools/list too", async () => {
    const r = await rig({});
    const tools = await r.client.listTools();
    assert.deepEqual(
      tools.tools.map((t) => t.name),
      ["create_charge", "list_charges"],
    );
    assert.equal(tools.tools[0]!.annotations?.idempotentHint, false);
    const out = await r.clock.run(() => r.charge());
    assert.ok(out !== "timeout");
    assert.equal(JSON.parse(out.text).status, "succeeded");
    assert.equal(r.clock.now(), 100, "one call's latency");
    assert.equal(r.ledger.effects.length, 1);
    assert.equal(r.engine.trace[0]!.outcome, "delivered");
    await r.close();
  });

  test("F1 lost response: the charge commits, the client times out", async () => {
    const r = await rig({ rules: [{ fault: "lost_response" }] });
    assert.equal(await r.clock.run(() => r.charge()), "timeout");
    assert.equal(r.ledger.effects.length, 1);
    assert.equal(r.clock.now(), 30_000);
    assert.equal(r.engine.trace[0]!.outcome, "dropped");
    await r.close();
  });

  test("F2 lost request: nothing commits, the client times out", async () => {
    const r = await rig({ rules: [{ fault: "lost_request" }] });
    assert.equal(await r.clock.run(() => r.charge()), "timeout");
    assert.equal(r.ledger.effects.length, 0);
    assert.equal(r.engine.trace[0]!.forwarded, 0);
    await r.close();
  });

  test("F3 duplicate delivery: two charges without a key, one with", async () => {
    const r = await rig({ rules: [{ fault: "duplicate", times: 2 }] });
    const plain = await r.clock.run(() => r.charge());
    assert.ok(plain !== "timeout");
    assert.equal(r.ledger.effects.length, 2);
    assert.equal(r.engine.trace[0]!.forwarded, 2);
    const keyed = await r.clock.run(() => r.charge({ customer: "cus_ada", amount_cents: 4900, reference: "inv_2", idempotency_key: "k" }));
    assert.ok(keyed !== "timeout");
    assert.equal(r.ledger.effects.length, 3, "the copy was deduplicated");
    await r.close();
  });

  test("F4 slow tool: the client gives up at 30 s, the charge still lands at 45 s", async () => {
    const r = await rig({ rules: [{ fault: "slow" }] });
    assert.equal(await r.clock.run(() => r.charge()), "timeout");
    assert.equal(r.ledger.effects.length, 0, "not yet");
    await r.clock.drain();
    assert.equal(r.ledger.effects.length, 1);
    assert.equal(r.ledger.effects[0]!.t, 45_100);
    assert.equal(r.engine.trace[0]!.outcome, "abandoned");
    await r.close();
  });

  test("F4 slow, then a keyed retry: the late original is a replay, not a second charge", async () => {
    const r = await rig({ rules: [{ fault: "slow" }] });
    const args = { customer: "cus_ada", amount_cents: 4900, reference: "inv_1", idempotency_key: "k1" };
    await r.clock.run(async () => {
      assert.equal(await r.charge(args), "timeout");
      const retry = await r.charge(args);
      assert.ok(retry !== "timeout");
    });
    await r.clock.drain();
    assert.equal(r.ledger.effects.length, 1);
    assert.equal(r.ledger.effects[0]!.t, 30_100, "the retry committed first");
    await r.close();
  });

  test("F5 garbled and F6 truncated: committed, the text no longer parses, structured content is gone", async () => {
    for (const fault of ["garbled", "truncated"] as const) {
      const r = await rig({ rules: [{ fault }] });
      const out = await r.clock.run(() => r.charge());
      assert.ok(out !== "timeout");
      assert.throws(() => JSON.parse(out.text));
      assert.equal(out.structured, undefined);
      assert.equal(r.ledger.effects.length, 1);
      await r.close();
    }
  });

  test("F7 rate limit: 429 with Retry-After, nothing runs until the window ends", async () => {
    const r = await rig({ rules: [{ fault: "rate_limit", windowMs: 10_000 }] });
    await r.clock.run(async () => {
      const first = await r.charge();
      assert.ok(first !== "timeout" && first.isError);
      assert.deepEqual(JSON.parse(first.text), { error: "rate_limited", status: 429, message: "Too many requests. Retry after 10 s.", retry_after_ms: 10_000 });
      const second = await r.charge();
      assert.ok(second !== "timeout" && second.isError);
      assert.equal(JSON.parse(second.text).retry_after_ms, 9_900);
      await r.clock.sleep(10_000);
      const third = await r.charge();
      assert.ok(third !== "timeout" && !third.isError);
    });
    assert.equal(r.ledger.effects.length, 1);
    assert.equal(r.engine.injected, 1);
    await r.close();
  });

  test("F8 and F9 crashes: the harness is told; the reply never arrives", async () => {
    for (const [fault, effects] of [
      ["crash_before", 0],
      ["crash_after", 1],
    ] as const) {
      const r = await rig({ rules: [{ fault }] });
      assert.equal(await r.clock.run(() => r.charge(undefined, 5_000)), "timeout");
      assert.equal(r.crashes.length, 1);
      assert.equal(r.crashes[0]!.point, fault === "crash_before" ? "before" : "after");
      assert.equal(r.ledger.effects.length, effects);
      await r.close();
    }
  });

  test("a 2026-07-28 client gets resultType on the proxy's own 429", async () => {
    const r = await rig({ rules: [{ fault: "rate_limit" }] }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const out = await r.clock.run(() => r.charge());
    assert.ok(out !== "timeout" && out.isError);
    assert.equal(JSON.parse(out.text).error, "rate_limited");
    // And ordinary calls still go through over the new handshake.
    const ok = await r.clock.run(() => r.charge());
    assert.ok(ok !== "timeout");
    assert.equal(r.engine.trace.length, 2);
    await r.close();
  });
});
