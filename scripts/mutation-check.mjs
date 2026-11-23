#!/usr/bin/env node
// Tests for the tests: plant one bug at a time in the recommended agent (or in the provider's
// dedup), run the lab for that agent, and check that the lab notices. A mutant that survives means
// the faults or the invariants miss that kind of bug. The source file is always restored, even on
// Ctrl-C.
//
//   node scripts/mutation-check.mjs

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = path.join(root, "src", "lab", "agents.ts");
const WORLD = path.join(root, "src", "sandbox", "world.ts");

const MUTANTS = [
  {
    name: "a new key on every attempt",
    file: AGENTS,
    from: 'const k = p.keys === "per-attempt" ? this.newKey(rt) : key;',
    to: 'const k = p.keys === "none" ? undefined : this.newKey(rt);',
  },
  {
    name: "the outbox key is saved after the call, not before",
    file: AGENTS,
    from: "state.outbox[step.id] = { key };\n          await persist();",
    to: "state.outbox[step.id] = { key };",
  },
  {
    name: "a resumed agent ignores its outbox",
    file: AGENTS,
    from: "key = state.outbox[step.id]?.key;",
    to: "key = undefined;",
  },
  {
    name: "the key is never sent",
    file: AGENTS,
    from: "const callArgs = k ? { ...args, [step.keyField]: k } : args;",
    to: "const callArgs = args;",
  },
  {
    name: "one key shared by every step",
    file: AGENTS,
    from: "return `ik_${randomHex(() => rt.random(), 8)}`;",
    to: 'return "ik_shared";',
  },
  {
    name: "Retry-After ignored",
    file: AGENTS,
    from: 'if (c.kind === "rate_limited" && p.honorRetryAfter) {',
    to: 'if (c.kind === "rate_limited" && false) {',
  },
  {
    // An earlier mutant here, "no checkpoint after a finished step", survived because it is
    // equivalent: the outbox write before the next step saves the same state.
    name: "a resumed agent redoes finished steps",
    file: AGENTS,
    from: 'if (rec) {\n        if (rec.status === "done"',
    to: 'if (rec && false) {\n        if (rec.status === "done"',
  },
  {
    name: "the provider forgets keys",
    file: WORLD,
    from: "if (saved) {",
    to: "if (saved && false) {",
  },
];

const tsx = import.meta.resolve("tsx");
function lab() {
  const res = spawnSync(process.execPath, ["--import", tsx, path.join(root, "src", "cli.ts"), "lab", "--agents", "idempotent", "--chaos", "100", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  let json;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    throw new Error(`the lab didn't print JSON (exit ${res.status}):\n${res.stderr}`);
  }
  const single = [...json.control, ...json.sweep].filter((r) => r.violations.length > 0);
  const chaos = json.chaos.filter((r) => r.violations.length > 0);
  return { single, chaos };
}

function caughtBy(runs) {
  const faults = new Set();
  const invariants = new Set();
  for (const r of runs) {
    faults.add(r.fault === null ? "control" : r.fault);
    for (const v of r.violations) invariants.add(v.invariant);
  }
  return `${[...invariants].sort().join(", ")} under ${[...faults].join(", ")}`;
}

const originals = new Map([AGENTS, WORLD].map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => {
  for (const [f, text] of originals) writeFileSync(f, text);
};
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    restore();
    process.exit(130);
  });
}

let survived = 0;
try {
  const clean = lab();
  if (clean.single.length > 0) throw new Error("the unmutated agent already breaks an invariant in a single-fault run");
  console.log(`unmutated: 0 single-fault runs and ${clean.chaos.length} chaos run(s) break an invariant\n`);
  for (const m of MUTANTS) {
    const original = originals.get(m.file);
    const count = original.split(m.from).length - 1;
    if (count !== 1) throw new Error(`mutant "${m.name}": pattern found ${count} times, expected 1`);
    writeFileSync(m.file, original.replace(m.from, m.to));
    const r = lab();
    writeFileSync(m.file, original);
    const killed = r.single.length > 0 || r.chaos.length > clean.chaos.length;
    if (!killed) survived++;
    const how = r.single.length > 0 ? `${r.single.length} single-fault runs: ${caughtBy(r.single)}` : `${r.chaos.length} chaos runs: ${caughtBy(r.chaos)}`;
    console.log(`${killed ? "killed  " : "SURVIVED"}  ${m.name}${killed ? `  (${how})` : ""}`);
  }
} finally {
  restore();
}
console.log(`\n${MUTANTS.length - survived}/${MUTANTS.length} mutants killed by the lab.`);
process.exit(survived === 0 ? 0 : 1);
