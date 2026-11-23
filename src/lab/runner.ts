import { CRASH_FAULTS, FAULT_KINDS, type FaultKind, type FaultPlanInput } from "../faults.js";
import type { Violation } from "../invariants.js";
import { check, type RunRecord, runInProcess, type RunSpec } from "./harness.js";
import { runInChildProcess } from "./process.js";
import { ABLATION, AGENTS, type Variant, variantById } from "./variants.js";
import { WORKFLOWS, type Workflow, workflowById } from "./workflows.js";

export type Mode = "inprocess" | "process";

export interface RunResult {
  variant: string;
  workflow: string;
  /** `null` for a fault-free run, `"chaos"` for random faults. */
  fault: FaultKind | null | "chaos";
  /** The call the fault hit (sweeps), or the seed (chaos). */
  position: number;
  violations: Violation[];
  calls: number;
  extraCalls: number;
  injected: number;
  crashes: number;
  elapsedMs: number;
}

export interface LabOptions {
  agents?: string[];
  faults?: FaultKind[];
  workflows?: string[];
  ablation?: boolean;
  /** Number of seeded random-fault runs per agent and workflow. 0 skips chaos. */
  chaos?: number;
  /** Chance of a fault on each call, in chaos runs. */
  rate?: number;
  mode?: Mode;
  onProgress?: (done: number) => void;
}

export interface LabResults {
  mode: Mode;
  agents: Variant[];
  ablation: Variant[];
  faults: FaultKind[];
  workflows: Workflow[];
  /** Fault-free runs, one per agent and workflow. */
  control: RunResult[];
  sweep: RunResult[];
  ablationSweep: RunResult[];
  chaos: RunResult[];
  chaosRate: number;
}

export const DEFAULT_CHAOS_RATE = 0.15;

async function runOne(mode: Mode, spec: RunSpec): Promise<RunRecord> {
  return mode === "process" ? runInChildProcess(spec) : runInProcess(spec);
}

function toResult(rec: RunRecord, workflow: Workflow, baseline: number, fault: RunResult["fault"], position: number): RunResult {
  const c = check(rec, workflow, baseline);
  return {
    variant: rec.variant,
    workflow: rec.workflow,
    fault,
    position,
    violations: c.violations,
    calls: c.calls,
    extraCalls: c.extraCalls,
    injected: rec.injected,
    crashes: rec.crashes,
    elapsedMs: rec.elapsedMs,
  };
}

/**
 * The lab. Every single fault is injected at every call position of every workflow, for every
 * agent. Chaos runs then mix random faults with fixed seeds. Every run is deterministic.
 */
export async function runLab(opts: LabOptions = {}): Promise<LabResults> {
  const mode = opts.mode ?? "inprocess";
  const agents = opts.agents ? opts.agents.map(variantById) : AGENTS;
  const workflows = opts.workflows ? opts.workflows.map(workflowById) : WORKFLOWS;
  let faults = opts.faults ?? [...FAULT_KINDS];
  // A real process can't run on simulated time, so process mode is for crashes only.
  if (mode === "process") faults = faults.filter((f) => CRASH_FAULTS.includes(f));
  const chaosRuns = mode === "process" ? 0 : (opts.chaos ?? 0);
  const rate = opts.rate ?? DEFAULT_CHAOS_RATE;
  const ablation = opts.ablation ? ABLATION : [];
  let done = 0;
  const tick = () => opts.onProgress?.(++done);

  const baselines = new Map<string, number>();
  const control: RunResult[] = [];
  const allVariants = [...agents, ...ablation.filter((a) => !agents.some((b) => b.id === a.id))];
  for (const v of allVariants) {
    for (const w of workflows) {
      const rec = await runOne(mode, { variant: v, workflow: w, plan: {} });
      baselines.set(`${v.id}/${w.id}`, rec.trace.length);
      const r = toResult(rec, w, rec.trace.length, null, 0);
      if (agents.includes(v)) control.push(r);
      tick();
    }
  }

  const sweepFor = async (variants: Variant[]): Promise<RunResult[]> => {
    const out: RunResult[] = [];
    for (const v of variants) {
      for (const fault of faults) {
        for (const w of workflows) {
          for (let position = 1; position <= w.steps.length; position++) {
            const plan: FaultPlanInput = { rules: [{ tool: "*", call: position, fault }] };
            const rec = await runOne(mode, { variant: v, workflow: w, plan });
            out.push(toResult(rec, w, baselines.get(`${v.id}/${w.id}`)!, fault, position));
            tick();
          }
        }
      }
    }
    return out;
  };

  const sweep = await sweepFor(agents);
  // Ablation columns that are also main agents reuse the main sweep.
  const ablationSweep = [
    ...sweep.filter((r) => ablation.some((a) => a.id === r.variant)),
    ...(await sweepFor(ablation.filter((a) => !agents.some((b) => b.id === a.id)))),
  ];

  const chaos: RunResult[] = [];
  for (const v of agents) {
    for (const w of workflows) {
      for (let seed = 1; seed <= chaosRuns; seed++) {
        const plan: FaultPlanInput = { random: { seed, rate, faults: [...FAULT_KINDS] } };
        const rec = await runOne(mode, { variant: v, workflow: w, plan, seed });
        chaos.push(toResult(rec, w, baselines.get(`${v.id}/${w.id}`)!, "chaos", seed));
        tick();
      }
    }
  }

  return { mode, agents, ablation, faults, workflows, control, sweep, ablationSweep, chaos, chaosRate: rate };
}
