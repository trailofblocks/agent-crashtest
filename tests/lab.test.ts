// The lab, with every number the README reports asserted here, so the tables can't drift.
import assert from "node:assert/strict";
import fs from "node:fs";
import { before, describe, test } from "node:test";
import type { FaultKind } from "../src/faults.js";
import type { InvariantId } from "../src/invariants.js";
import { brokenCounts, renderReport } from "../src/lab/report.js";
import { type LabResults, runLab } from "../src/lab/runner.js";

let results: LabResults;
before(async () => {
  results = await runLab({ ablation: true, chaos: 100 });
});

type Counts = Partial<Record<InvariantId, number>>;
const cell = (runs: LabResults["sweep"], variant: string, fault: FaultKind): Counts => {
  const rows = runs.filter((r) => r.variant === variant && r.fault === fault);
  assert.equal(rows.length, 13, `${variant}/${fault}: 13 positions`);
  return Object.fromEntries(Object.entries(brokenCounts(rows)).filter(([, n]) => n > 0));
};

const HELD: Counts = {};
const DOUBLE: Counts = { I1: 13 };
const MISREPORTED: Counts = { I2: 7, I5: 13 };

describe("main table: four agents, nine faults, 13 positions each", () => {
  const expected: Record<FaultKind, [Counts, Counts, Counts, Counts]> = {
    //               naive                          no-retry        framework  idempotent
    lost_response: [DOUBLE, MISREPORTED, DOUBLE, HELD],
    lost_request: [HELD, { I2: 13 }, HELD, HELD],
    duplicate: [DOUBLE, DOUBLE, DOUBLE, HELD],
    slow: [DOUBLE, MISREPORTED, DOUBLE, HELD],
    garbled: [DOUBLE, MISREPORTED, DOUBLE, HELD],
    truncated: [DOUBLE, MISREPORTED, DOUBLE, HELD],
    rate_limit: [{ I2: 13, I3: 13, I4: 13 }, { I2: 13 }, HELD, HELD],
    crash_before: [{ I1: 11, I4: 7 }, { I2: 13 }, HELD, HELD],
    crash_after: [{ I1: 13, I4: 7 }, MISREPORTED, DOUBLE, HELD],
  };
  for (const [fault, cells] of Object.entries(expected) as Array<[FaultKind, Counts[]]>) {
    test(fault, () => {
      ["naive", "no-retry", "framework", "idempotent"].forEach((v, i) => assert.deepEqual(cell(results.sweep, v, fault), cells[i], v));
    });
  }

  test("no agent breaks anything without faults", () => {
    assert.equal(results.control.length, 8);
    for (const r of results.control) assert.deepEqual(r.violations, [], r.variant);
  });

  test("the idempotent agent's runs cost at most one extra call per fault", () => {
    const runs = results.sweep.filter((r) => r.variant === "idempotent");
    assert.ok(runs.every((r) => r.extraCalls <= 1), JSON.stringify(runs.filter((r) => r.extraCalls > 1)));
    assert.ok(runs.every((r) => r.crashes <= 1));
  });

  test("the naive agent's rate-limit loop is stopped by the watchdog at 200 calls", () => {
    const runs = results.sweep.filter((r) => r.variant === "naive" && r.fault === "rate_limit");
    assert.ok(runs.every((r) => r.calls === 200));
  });
});

describe("ablation: the recommended agent, one piece at a time", () => {
  const expected: Record<string, Partial<Record<FaultKind, Counts>>> = {
    framework: { lost_response: DOUBLE, duplicate: DOUBLE, slow: DOUBLE, garbled: DOUBLE, truncated: DOUBLE, crash_after: DOUBLE },
    "key-per-attempt": { lost_response: DOUBLE, slow: DOUBLE, garbled: DOUBLE, truncated: DOUBLE, crash_after: DOUBLE },
    "key-in-memory": { crash_after: DOUBLE },
    idempotent: {},
    "provider-ignores-keys": { lost_response: DOUBLE, duplicate: DOUBLE, slow: DOUBLE, garbled: DOUBLE, truncated: DOUBLE, crash_after: DOUBLE },
    "no-backoff": { rate_limit: { I2: 13, I4: 6 } },
  };
  for (const [variant, faults] of Object.entries(expected)) {
    test(variant, () => {
      for (const f of results.faults) assert.deepEqual(cell(results.ablationSweep, variant, f), faults[f] ?? HELD, `${variant}/${f}`);
    });
  }
});

describe("chaos: 100 seeds per workflow, 15% faults per call", () => {
  const expected: Record<string, Counts & { any: number }> = {
    naive: { I1: 92, I2: 32, I3: 32, I4: 41, any: 110 },
    "no-retry": { I1: 12, I2: 98, I5: 77, any: 123 },
    framework: { I1: 94, I2: 1, I5: 2, any: 94 },
    idempotent: { I2: 1, any: 1 },
  };
  for (const [variant, want] of Object.entries(expected)) {
    test(variant, () => {
      const runs = results.chaos.filter((r) => r.variant === variant);
      assert.equal(runs.length, 200);
      const counts = Object.fromEntries(Object.entries(brokenCounts(runs)).filter(([, n]) => n > 0));
      const { any, ...rest } = want;
      assert.deepEqual(counts, rest);
      assert.equal(runs.filter((r) => r.violations.length > 0).length, any);
    });
  }

  test("the idempotent agent never double-commits, and its one loss is a retry budget running out", () => {
    const bad = results.chaos.filter((r) => r.variant === "idempotent" && r.violations.length > 0);
    assert.equal(bad.length, 1);
    assert.equal(bad[0]!.workflow, "checkout");
    assert.equal(bad[0]!.injected, 3, "three faults hit the same charge in a row");
    assert.deepEqual(bad[0]!.violations, [{ invariant: "I2", detail: "never committed: email for cart_7781" }]);
  });
});

test("the README's tables are this run's output", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const m = readme.match(/<!-- lab:start -->\n([\s\S]*?)\n<!-- lab:end -->/);
  assert.ok(m, "README has the lab block");
  assert.equal(m[1]!.trim(), renderReport(results).trim());
});
