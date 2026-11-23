// Crashes in a real child process, killed for real, must come out the same as the simulated crash.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FaultKind } from "../src/faults.js";
import { check, runInProcess } from "../src/lab/harness.js";
import { runInChildProcess } from "../src/lab/process.js";
import { AGENTS } from "../src/lab/variants.js";
import { workflowById } from "../src/lab/workflows.js";

const CASES: Array<[string, FaultKind, number]> = [
  ["billing", "crash_after", 1],
  ["billing", "crash_before", 6],
  ["checkout", "crash_after", 3],
];

describe("process mode matches the in-process crash model", () => {
  for (const variant of AGENTS) {
    for (const [wf, fault, position] of CASES) {
      test(`${variant.id}: ${fault} at call ${position} of ${wf}`, async () => {
        const workflow = workflowById(wf);
        const spec = { variant, workflow, plan: { rules: [{ fault, call: position }] } };
        const sim = await runInProcess(spec);
        const real = await runInChildProcess(spec);
        assert.equal(real.crashes, 1, "the child was killed once");
        assert.equal(real.finished, true);
        const baseline = workflow.steps.length;
        assert.deepEqual(check(real, workflow, baseline).violations, check(sim, workflow, baseline).violations);
        assert.deepEqual(
          real.effects.map((e) => `${e.kind}:${e.ref}`),
          sim.effects.map((e) => `${e.kind}:${e.ref}`),
        );
        assert.deepEqual(
          real.report?.steps.map((s) => s.status),
          sim.report?.steps.map((s) => s.status),
        );
      });
    }
  }
});
