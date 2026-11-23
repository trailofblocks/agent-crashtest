import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { SimClock } from "../src/clock.js";
import { FAULT_KINDS, FaultEngine, garbleText, parsePlan, truncateText } from "../src/faults.js";
import { checkInvariants } from "../src/invariants.js";
import { classify } from "../src/lab/agents.js";
import { type Effect, Ledger } from "../src/ledger.js";
import { SandboxWorld } from "../src/sandbox/world.js";
import { RateLimitError, ToolTimeoutError, withFaults } from "../src/wrap.js";

describe("SimClock", () => {
  test("fires timers in time order, ties in the order they were set", async () => {
    const clock = new SimClock();
    const seen: string[] = [];
    await clock.run(async () => {
      clock.setTimer(30, () => seen.push("c"));
      clock.setTimer(10, () => seen.push("a"));
      clock.setTimer(10, () => seen.push("b"));
      await clock.sleep(50);
    });
    assert.deepEqual(seen, ["a", "b", "c"]);
    assert.equal(clock.now(), 50);
  });

  test("a minute of backoff takes no real time", async () => {
    const clock = new SimClock();
    const t = Date.now();
    await clock.run(async () => {
      for (let i = 0; i < 60; i++) await clock.sleep(1000);
    });
    assert.equal(clock.now(), 60_000);
    assert.ok(Date.now() - t < 2000);
  });

  test("reports a deadlock instead of hanging", async () => {
    const clock = new SimClock();
    await assert.rejects(clock.run(() => new Promise(() => {})), /deadlock/);
  });

  test("cancelled timers don't fire, and drain runs what is left", async () => {
    const clock = new SimClock();
    const seen: number[] = [];
    const cancel = clock.setTimer(5, () => seen.push(5));
    clock.setTimer(7, () => seen.push(7));
    cancel();
    await clock.drain();
    assert.deepEqual(seen, [7]);
  });
});

describe("fault plans and the engine", () => {
  test("defaults", () => {
    const p = parsePlan({ rules: [{ fault: "slow" }] });
    assert.deepEqual(p.rules[0], { tool: "*", call: 1, times: 1, fault: "slow" });
    assert.equal(p.slowMs, 45_000);
    assert.equal(p.rateLimitMs, 60_000);
    assert.throws(() => parsePlan({ rules: [{ fault: "meteor" }] }));
  });

  test("a rule hits the nth matching call, `times` in a row", () => {
    const e = new FaultEngine({ rules: [{ tool: "payments/*", call: 2, times: 2, fault: "lost_response" }] });
    const got = [
      e.decide("orders", "create_order", {}, 0).decision.fault,
      e.decide("payments", "create_charge", {}, 0).decision.fault,
      e.decide("payments", "create_charge", {}, 0).decision.fault,
      e.decide("payments", "list_charges", {}, 0).decision.fault,
      e.decide("payments", "create_charge", {}, 0).decision.fault,
    ];
    assert.deepEqual(got, [null, null, "lost_response", "lost_response", null]);
    assert.equal(e.injected, 2);
    assert.deepEqual(
      e.trace.map((t) => t.n),
      [1, 2, 3, 4, 5],
    );
  });

  test("a rate limit holds the whole provider for its window, and counts as one fault", () => {
    const e = new FaultEngine({ rules: [{ tool: "email/*", fault: "rate_limit", windowMs: 1000 }] });
    assert.equal(e.decide("email", "send_email", {}, 0).decision.retryAfterMs, 1000);
    const again = e.decide("email", "list_sent", {}, 400);
    assert.equal(again.entry.limited, true);
    assert.equal(again.decision.retryAfterMs, 600);
    assert.equal(e.decide("payments", "create_charge", {}, 400).entry.limited, false);
    assert.equal(e.decide("email", "send_email", {}, 1000).entry.limited, false);
    assert.equal(e.injected, 1);
  });

  test("random faults are the same for the same seed", () => {
    const run = (seed: number) => {
      const e = new FaultEngine({ random: { seed, rate: 0.3, faults: [...FAULT_KINDS] } }, { allowCrash: true });
      return Array.from({ length: 200 }, (_, i) => e.decide("s", "t", {}, i * 100_000).decision.fault);
    };
    assert.deepEqual(run(7), run(7));
    assert.notDeepEqual(run(7), run(8));
    const kinds = new Set(run(7).filter(Boolean));
    assert.ok(kinds.size >= 7, `expected most kinds, got ${[...kinds].join(",")}`);
  });

  test("random faults stop at `max`", () => {
    const e = new FaultEngine({ random: { seed: 1, rate: 1, faults: ["duplicate"], max: 3 } });
    for (let i = 0; i < 10; i++) e.decide("s", "t", {}, 0);
    assert.equal(e.injected, 3);
  });

  test("crash faults need a harness that owns the agent", () => {
    assert.throws(() => new FaultEngine({ rules: [{ fault: "crash_after" }] }), /harness/);
    assert.throws(() => new FaultEngine({ random: { seed: 1, rate: 0.1, faults: ["crash_before"] } }), /harness/);
    assert.doesNotThrow(() => new FaultEngine({ rules: [{ fault: "crash_after" }] }, { allowCrash: true }));
  });

  test("garbled and truncated replies don't parse", () => {
    const reply = JSON.stringify({ id: "ch_0001", object: "charge", status: "succeeded", amount_cents: 4900, reference: "inv_2001" });
    assert.throws(() => JSON.parse(garbleText(reply)));
    assert.throws(() => JSON.parse(truncateText(reply)));
    assert.ok(garbleText(reply).startsWith(reply.slice(0, 10)));
  });
});

describe("the sandbox world", () => {
  const world = (opts = {}) => new SandboxWorld(new Ledger(), new SimClock(), opts);
  const charge = { customer: "cus_ada", amount_cents: 4900, reference: "inv_1" };

  test("a repeated key returns the first charge and commits nothing", () => {
    const w = world();
    const a = w.createCharge({ ...charge, idempotency_key: "k1" });
    const b = w.createCharge({ ...charge, idempotency_key: "k1" });
    assert.equal(w.ledger.effects.length, 1);
    assert.equal(b.body.id, a.body.id);
    assert.equal(b.body.idempotent_replayed, true);
  });

  test("a repeated key with different arguments is refused", () => {
    const w = world();
    w.createCharge({ ...charge, idempotency_key: "k1" });
    const b = w.createCharge({ ...charge, amount_cents: 9900, idempotency_key: "k1" });
    assert.equal(b.isError, true);
    assert.equal(b.body.error, "idempotency_key_reused");
    assert.equal(w.ledger.effects.length, 1);
  });

  test("without a key, or with dedup off, every call commits", () => {
    const w = world();
    w.createCharge(charge);
    w.createCharge(charge);
    assert.equal(w.ledger.effects.length, 2);
    const off = world({ dedup: false });
    off.sendEmail({ to: "a@example.com", subject: "s", body: "b", reference: "r", idempotency_key: "k" });
    off.sendEmail({ to: "a@example.com", subject: "s", body: "b", reference: "r", idempotency_key: "k" });
    assert.equal(off.ledger.effects.length, 2);
  });

  test("orders dedup on client_order_id", () => {
    const w = world();
    const args = { customer: "c", items: [{ sku: "x", qty: 1 }], total_cents: 100, reference: "cart_1", client_order_id: "co_1" };
    const a = w.createOrder(args);
    const b = w.createOrder(args);
    assert.equal(w.ledger.effects.length, 1);
    assert.equal(b.body.id, a.body.id);
  });

  test("a restarted server remembers keys from its ledger file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crashtest-test-"));
    const file = path.join(dir, "ledger.jsonl");
    try {
      new SandboxWorld(new Ledger(file), new SimClock()).createCharge({ ...charge, idempotency_key: "k9" });
      const again = new SandboxWorld(new Ledger(file), new SimClock());
      const r = again.createCharge({ ...charge, idempotency_key: "k9" });
      assert.equal(r.body.idempotent_replayed, true);
      assert.equal(Ledger.read(file).length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("invariants", () => {
  const eff = (n: number, kind: Effect["kind"], ref: string, data: Record<string, unknown> = {}): Effect => ({ seq: n, t: 0, service: "s", kind, ref, id: `x_${n}`, data });
  const expected = [
    { kind: "charge" as const, ref: "inv_1", match: { amount_cents: 4900 } },
    { kind: "email" as const, ref: "inv_1" },
  ];

  test("a clean run holds everything", () => {
    const r = checkInvariants({ expected, effects: [eff(1, "charge", "inv_1", { amount_cents: 4900 }), eff(2, "email", "inv_1")], finished: true });
    assert.deepEqual(r.violations, []);
  });

  test("I1: a double charge, a wrong amount, and an unexpected effect", () => {
    const r = checkInvariants({
      expected,
      effects: [eff(1, "charge", "inv_1", { amount_cents: 4900 }), eff(2, "charge", "inv_1", { amount_cents: 4900 }), eff(3, "email", "inv_1"), eff(4, "order", "cart_9")],
    });
    assert.deepEqual(
      r.violations.map((v) => v.invariant),
      ["I1", "I1"],
    );
    assert.match(r.violations[0]!.detail, /committed 2 times \(\$49\.00 \+ \$49\.00\)/);
    const wrong = checkInvariants({ expected, effects: [eff(1, "charge", "inv_1", { amount_cents: 1 }), eff(2, "email", "inv_1")] });
    assert.match(wrong.violations[0]!.detail, /amount_cents 1, expected 4900/);
  });

  test("I2: a missing effect, or a run that didn't finish", () => {
    const r = checkInvariants({ expected, effects: [eff(1, "charge", "inv_1", { amount_cents: 4900 })], finished: false, stopped: "watchdog" });
    assert.deepEqual(
      r.violations.map((v) => v.invariant),
      ["I2", "I2"],
    );
  });

  test("I3 and I4 come from the trace", () => {
    const trace = Array.from({ length: 8 }, (_, i) => ({
      n: i + 1,
      t: 0,
      server: "payments",
      tool: "create_charge",
      args: { reference: "inv_1" },
      fault: null,
      limited: false,
      forwarded: 1,
    }));
    const r = checkInvariants({ expected: [], effects: [], trace, baselineCalls: 1, injected: 1 });
    assert.deepEqual(
      r.violations.map((v) => v.invariant),
      ["I3", "I4"],
    );
    assert.equal(r.extraCalls, 7);
    const ok = checkInvariants({ expected: [], effects: [], trace: trace.slice(0, 4), baselineCalls: 1, injected: 1 });
    assert.deepEqual(ok.violations, []);
  });

  test("I5: the report must match the ledger, and unknown is always honest", () => {
    const r = checkInvariants({
      expected,
      effects: [eff(1, "charge", "inv_1", { amount_cents: 4900 })],
      report: [
        { kind: "charge", ref: "inv_1", status: "failed" },
        { kind: "email", ref: "inv_1", status: "done" },
      ],
    });
    assert.deepEqual(
      r.violations.filter((v) => v.invariant === "I5").map((v) => v.detail),
      ["reported the charge for inv_1 failed, but it went through", "reported the email for inv_1 done, but it never happened"],
    );
    const honest = checkInvariants({ expected, effects: [eff(1, "charge", "inv_1", { amount_cents: 4900 })], report: [{ kind: "charge", ref: "inv_1", status: "unknown" }] });
    assert.equal(honest.violations.filter((v) => v.invariant === "I5").length, 0);
  });
});

describe("reading a reply", () => {
  test("classify", () => {
    assert.equal(classify({ kind: "timeout" }).kind, "ambiguous");
    assert.equal(classify({ kind: "reply", isError: false, text: '{"id":"ch_1"' }).kind, "ambiguous");
    assert.equal(classify({ kind: "reply", isError: false, text: '{"id":"ch_1"}' }).kind, "ok");
    assert.deepEqual(classify({ kind: "reply", isError: true, text: '{"error":"rate_limited","retry_after_ms":500}' }), { kind: "rate_limited", retryAfterMs: 500 });
    assert.equal(classify({ kind: "reply", isError: true, text: '{"error":"idempotency_key_reused","message":"no"}' }).kind, "rejected");
  });
});

describe("withFaults, for tools that aren't MCP", () => {
  const make = (fault: (typeof FAULT_KINDS)[number], extra: Record<string, unknown> = {}) => {
    const calls: unknown[] = [];
    const clock = new SimClock();
    const engine = new FaultEngine({ rules: [{ fault, ...extra }] }, { allowCrash: true });
    let crashed = false;
    const fn = withFaults(async (a: { reference: string }) => {
      calls.push(a);
      return { id: `ch_${calls.length}`, reference: a.reference };
    }, { name: "charge", engine, clock, timeoutMs: 30_000, onCrash: () => (crashed = true) });
    return { fn, calls, clock, engine, crashed: () => crashed };
  };

  test("lost response: the function ran, the caller gets a timeout", async () => {
    const t = make("lost_response");
    await assert.rejects(t.clock.run(() => t.fn({ reference: "r" })), ToolTimeoutError);
    assert.equal(t.calls.length, 1);
    assert.equal(t.clock.now(), 30_000);
  });

  test("lost request: the function never ran", async () => {
    const t = make("lost_request");
    await assert.rejects(t.clock.run(() => t.fn({ reference: "r" })), ToolTimeoutError);
    assert.equal(t.calls.length, 0);
  });

  test("duplicate: it ran twice, the caller sees the first result", async () => {
    const t = make("duplicate");
    assert.deepEqual(await t.clock.run(() => t.fn({ reference: "r" })), { id: "ch_1", reference: "r" });
    assert.equal(t.calls.length, 2);
  });

  test("slow past the timeout: the caller gives up, the function still runs later", async () => {
    const t = make("slow");
    await assert.rejects(t.clock.run(() => t.fn({ reference: "r" })), ToolTimeoutError);
    assert.equal(t.calls.length, 0);
    await t.clock.drain();
    assert.equal(t.calls.length, 1);
    assert.equal(t.clock.now(), 45_000);
  });

  test("garbled: damaged text comes back", async () => {
    const t = make("garbled");
    const out = await t.clock.run(() => t.fn({ reference: "r" }));
    assert.equal(typeof out, "string");
    assert.throws(() => JSON.parse(out as string));
  });

  test("rate limit: refused without running", async () => {
    const t = make("rate_limit");
    const err = await t.clock.run(() => t.fn({ reference: "r" }).catch((e: unknown) => e));
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.retryAfterMs, 60_000);
    assert.equal(t.calls.length, 0);
  });

  test("crash after: the function ran, onCrash fired, the call never settles", async () => {
    const t = make("crash_after");
    let settled = false;
    void t.fn({ reference: "r" }).finally(() => (settled = true));
    await new Promise((r) => setImmediate(r));
    assert.equal(t.calls.length, 1);
    assert.equal(t.crashed(), true);
    assert.equal(settled, false);
  });
});
