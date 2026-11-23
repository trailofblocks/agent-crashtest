import { FAULT_INFO, type FaultKind } from "../faults.js";
import { INVARIANT_IDS, type InvariantId } from "../invariants.js";
import type { LabResults, RunResult } from "./runner.js";
import type { Variant } from "./variants.js";

/** How many runs broke each invariant. */
export function brokenCounts(runs: RunResult[]): Record<InvariantId, number> {
  const out = { I1: 0, I2: 0, I3: 0, I4: 0, I5: 0 } as Record<InvariantId, number>;
  for (const r of runs) for (const id of new Set(r.violations.map((v) => v.invariant))) out[id]++;
  return out;
}

function cell(runs: RunResult[]): string {
  if (runs.length === 0) return "-";
  const counts = brokenCounts(runs);
  const broken = INVARIANT_IDS.filter((id) => counts[id] > 0);
  if (broken.length === 0) return "held";
  return broken.map((id) => `**${id}** ${counts[id]}/${runs.length}`).join(", ");
}

function faultTable(results: LabResults, runs: RunResult[], variants: Variant[], withBreaks: boolean): string[] {
  const out: string[] = [];
  out.push(`| | Fault | ${variants.map((v) => v.label).join(" | ")} |${withBreaks ? " Breaks |" : ""}`);
  out.push(`| --- | --- | ${variants.map(() => "---").join(" | ")} |${withBreaks ? " --- |" : ""}`);
  if (withBreaks && results.control.length) {
    const cells = variants.map((v) => cell(results.control.filter((r) => r.variant === v.id)));
    out.push(`| | No fault (control) | ${cells.join(" | ")} | - |`);
  }
  for (const f of results.faults) {
    const info = FAULT_INFO[f];
    const row = runs.filter((r) => r.fault === f);
    const cells = variants.map((v) => cell(row.filter((r) => r.variant === v.id)));
    const counts = brokenCounts(row);
    const breaks = INVARIANT_IDS.filter((id) => counts[id] > 0).join(", ") || "nothing";
    out.push(`| **${info.id}** | ${info.title} | ${cells.join(" | ")} |${withBreaks ? ` ${breaks} |` : ""}`);
  }
  return out;
}

/** Agents in the order their breaks make the best example: the common default first. */
const EXAMPLE_ORDER = ["framework", "no-retry", "naive"];

/** One concrete example of each break, so the table's counts have a face. Money first. */
function examples(results: LabResults): string[] {
  const out: string[] = [];
  const rank = (id: string) => {
    const i = EXAMPLE_ORDER.indexOf(id);
    return i < 0 ? EXAMPLE_ORDER.length : i;
  };
  for (const f of results.faults) {
    // A rate limit's telling break is the loop that never stops.
    const first = f === "rate_limit" ? "naive" : undefined;
    const candidates = results.sweep
      .filter((x) => x.fault === f && x.violations.length > 0)
      .sort((a, b) => (a.variant === first ? -1 : b.variant === first ? 1 : rank(a.variant) - rank(b.variant)));
    const best = candidates.find((r) => r.variant === candidates[0]?.variant && r.violations.some((v) => v.detail.includes("charge"))) ?? candidates[0];
    if (!best) continue;
    const v = best.violations.find((x) => x.invariant === "I3") ?? best.violations.find((x) => x.detail.includes("charge")) ?? best.violations[0]!;
    const label = results.agents.find((a) => a.id === best.variant)?.label ?? best.variant;
    out.push(`- **${FAULT_INFO[f].id}, ${label.toLowerCase()}** (${best.workflow}, fault on call ${best.position}): ${v.invariant}, ${v.detail}.`);
  }
  return out;
}

function pct(k: number, n: number): string {
  if (n === 0) return "-";
  const p = (100 * k) / n;
  return `${k}/${n} (${p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)}%)`;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function chaosTable(results: LabResults): string[] {
  const out: string[] = [];
  out.push(`| Agent | ${INVARIANT_IDS.join(" | ")} | Any | Faults per run (mean) | Extra calls (median) |`);
  out.push(`| --- | ${INVARIANT_IDS.map(() => "---").join(" | ")} | --- | --- | --- |`);
  for (const v of results.agents) {
    const runs = results.chaos.filter((r) => r.variant === v.id);
    if (!runs.length) continue;
    const counts = brokenCounts(runs);
    const any = runs.filter((r) => r.violations.length > 0).length;
    const faults = runs.reduce((n, r) => n + r.injected, 0) / runs.length;
    out.push(
      `| ${v.label} | ${INVARIANT_IDS.map((id) => pct(counts[id], runs.length)).join(" | ")} | ${pct(any, runs.length)} | ${faults.toFixed(2)} | ${median(runs.map((r) => r.extraCalls))} |`,
    );
  }
  return out;
}

/** Markdown tables for the README and the CLI. */
export function renderReport(results: LabResults): string {
  const out: string[] = [];
  const positions = results.workflows.reduce((n, w) => n + w.steps.length, 0);
  out.push(
    `Each cell counts the runs that broke an invariant, out of ${positions}: every fault injected once at every call position of ${results.workflows.map((w) => w.id).join(" and ")}.`,
    "",
  );
  out.push(...faultTable(results, results.sweep, results.agents, true), "");

  const ex = examples(results);
  if (ex.length) out.push("What a break looks like:", "", ...ex, "");

  if (results.ablationSweep.length) {
    out.push("The recommended agent, one piece at a time:", "");
    out.push(...faultTable(results, results.ablationSweep, results.ablation, false), "");
  }
  if (results.chaos.length) {
    const perAgent = results.chaos.filter((r) => r.variant === results.agents[0]?.id).length;
    out.push(
      `Random faults: ${perAgent} seeded runs per agent, a ${Math.round(results.chaosRate * 100)}% chance of a fault on each call (any of F1 to F9).`,
      "",
    );
    out.push(...chaosTable(results), "");
  }
  out.push(summary(results));
  return out.join("\n");
}

export function summary(results: LabResults): string {
  const parts: string[] = [];
  for (const v of results.agents) {
    const runs = results.sweep.filter((r) => r.variant === v.id);
    const broken = runs.filter((r) => r.violations.length > 0).length;
    parts.push(`${v.label}: ${broken}/${runs.length} single-fault runs broke an invariant`);
  }
  return `${parts.join(". ")}.`;
}

/** Runs where an agent that should hold broke something. The CLI exits non-zero if there are any. */
export function regressions(results: LabResults, mustHold = "idempotent"): RunResult[] {
  // The ablation reuses the main sweep's runs for agents in both, so count each run once.
  const runs = new Set([...results.control, ...results.sweep, ...results.ablationSweep]);
  return [...runs].filter((r) => r.variant === mustHold && r.violations.length > 0);
}

export function faultsArg(list: string): FaultKind[] {
  const out: FaultKind[] = [];
  for (const raw of list.split(",").map((s) => s.trim()).filter(Boolean)) {
    const byId = (Object.keys(FAULT_INFO) as FaultKind[]).find((k) => FAULT_INFO[k].id.toLowerCase() === raw.toLowerCase() || k === raw);
    if (!byId) throw new Error(`unknown fault ${raw}; use F1-F9 or a name such as lost_response`);
    out.push(byId);
  }
  return out;
}
