#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Command, InvalidArgumentError, Option } from "commander";
import { z } from "zod";
import { RealClock } from "./clock.js";
import { FAULT_INFO, FAULT_KINDS, FaultEngine, parsePlan, type TraceEntry } from "./faults.js";
import { checkInvariants, INVARIANT_IDS, INVARIANTS } from "./invariants.js";
import { Ledger } from "./ledger.js";
import { faultsArg, regressions, renderReport } from "./lab/report.js";
import { DEFAULT_CHAOS_RATE, type Mode, runLab } from "./lab/runner.js";
import { FaultProxy } from "./proxy.js";
import { createSandboxServer } from "./sandbox/server.js";
import { SandboxWorld, SERVICES, type ServiceName } from "./sandbox/world.js";

const VERSION: string = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("expected a whole number");
  return n;
}

function rate(value: string): number {
  const n = Number(value);
  if (!(n >= 0 && n <= 1)) throw new InvalidArgumentError("expected a number from 0 to 1");
  return n;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** A JSON file, or inline JSON. */
function readJson(value: string): unknown {
  const text = value.trim().startsWith("{") ? value : fs.readFileSync(path.resolve(value), "utf8");
  return JSON.parse(text.replace(/^﻿/, ""));
}

const program = new Command()
  .name("crashtest")
  .description("Chaos testing for AI agents: inject faults between an agent and its tools, then check for double charges, lost work, and runaway retries.")
  .version(VERSION)
  .enablePositionalOptions();

// -------------------------------------------------------------------------------------------- lab

program
  .command("lab")
  .description("Run the scripted agents through every fault at every call position, and print the tables")
  .option("--agents <ids>", "naive, no-retry, framework, idempotent, and the ablation variants", list)
  .option("--faults <ids>", "F1-F9 or names such as lost_response", faultsArg)
  .option("--workflows <ids>", "checkout, billing", list)
  .option("--ablation", "also run the recommended agent with one piece of the fix removed at a time")
  .option("--chaos <n>", "seeded random-fault runs per agent and workflow (0 to skip)", positiveInt, 100)
  .option("--rate <r>", "chance of a fault on each call, in chaos runs", rate, DEFAULT_CHAOS_RATE)
  .addOption(new Option("--mode <mode>", "inprocess: simulated time and crashes. process: real child processes, killed for real (crash faults only)").choices(["inprocess", "process"]).default("inprocess"))
  .option("--gate <agent>", "exit 1 if this agent breaks an invariant in a single-fault run", "idempotent")
  .option("--json", "print the raw results as JSON")
  .action(async (opts: { agents?: string[]; faults?: (typeof FAULT_KINDS)[number][]; workflows?: string[]; ablation?: boolean; chaos: number; rate: number; mode: Mode; gate: string; json?: boolean }) => {
    const started = Date.now();
    const results = await runLab({
      agents: opts.agents,
      faults: opts.faults,
      workflows: opts.workflows,
      ablation: opts.ablation,
      chaos: opts.chaos,
      rate: opts.rate,
      mode: opts.mode,
      onProgress: (n) => {
        if (!opts.json && process.stderr.isTTY && n % 25 === 0) process.stderr.write(`\r${n} runs`);
      },
    });
    if (!opts.json && process.stderr.isTTY) process.stderr.write("\r");
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(results, (k, v) => (k === "policy" ? undefined : v), 2)}\n`);
    } else {
      process.stdout.write(`${renderReport(results)}\n`);
      const runs = results.control.length + results.sweep.length + results.ablationSweep.length + results.chaos.length;
      process.stderr.write(`\n${runs} runs in ${((Date.now() - started) / 1000).toFixed(1)} s (${opts.mode}).\n`);
    }
    const bad = regressions(results, opts.gate);
    if (bad.length) {
      process.stderr.write(`\nThe ${opts.gate} agent broke an invariant in ${bad.length} run(s):\n`);
      for (const r of bad.slice(0, 10)) process.stderr.write(`  ${r.workflow} ${String(r.fault)} @${r.position}: ${r.violations.map((v) => `${v.invariant} ${v.detail}`).join("; ")}\n`);
      // Not process.exit: let a large --json output finish writing to a pipe first.
      process.exitCode = 1;
    }
  });

// ------------------------------------------------------------------------------------------ proxy

program
  .command("proxy")
  .description("Inject faults in front of a stdio MCP server: crashtest proxy --faults plan.json -- <command...>")
  .argument("[command...]", "the server command, after --")
  .requiredOption("-f, --faults <plan>", "fault plan: a JSON file, or inline JSON")
  .option("-n, --name <name>", "server name that fault rules match (server/tool)", "server")
  .option("-t, --trace <file>", "append every tool call and its fault to this JSONL file")
  .option("-q, --quiet", "don't print injected faults to stderr")
  .passThroughOptions()
  .action(async (cmd: string[], opts: { faults: string; name: string; trace?: string; quiet?: boolean }) => {
    if (cmd.length === 0) fail("no server command. Usage: crashtest proxy --faults plan.json -- <command> [args...]");
    let engine: FaultEngine;
    try {
      engine = new FaultEngine(parsePlan(readJson(opts.faults)));
    } catch (e) {
      fail(`invalid fault plan: ${(e as Error).message}`);
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    const upstream = new StdioClientTransport({ command: cmd[0]!, args: cmd.slice(1), env, stderr: "inherit" });
    const trace = opts.trace ? path.resolve(opts.trace) : undefined;
    const proxy = new FaultProxy(new StdioServerTransport(), upstream, {
      server: opts.name,
      engine,
      clock: new RealClock(),
      onTrace: (e: TraceEntry) => {
        if (trace) fs.appendFileSync(trace, `${JSON.stringify(e)}\n`, "utf8");
        if (!opts.quiet && (e.fault || e.limited)) {
          const what = e.fault ? `${FAULT_INFO[e.fault].id} ${e.fault}` : "refused: still rate-limited";
          process.stderr.write(`[crashtest:${opts.name}] call ${e.n} ${e.server}/${e.tool}: ${what}\n`);
        }
      },
      log: opts.quiet ? undefined : (line) => process.stderr.write(`[crashtest:${opts.name}] ${line}\n`),
    });
    await proxy.start();
    await proxy.done;
    process.exit(0);
  });

// ------------------------------------------------------------------------------------------ serve

program
  .command("serve")
  .description("Run the sandbox tools (payments, orders, email) as one stdio MCP server, recording every effect in a ledger")
  .option("-s, --services <names>", "which services", list, SERVICES)
  .option("-l, --ledger <file>", "JSONL ledger of committed effects", "crashtest-ledger.jsonl")
  .option("--no-dedup", "ignore idempotency keys, like a provider that doesn't support them")
  .action(async (opts: { services: string[]; ledger: string; dedup: boolean }) => {
    const services = opts.services as ServiceName[];
    for (const s of services) if (!SERVICES.includes(s)) fail(`unknown service ${s}; choose from ${SERVICES.join(", ")}`);
    const clock = new RealClock();
    const world = new SandboxWorld(new Ledger(path.resolve(opts.ledger)), clock, { dedup: opts.dedup });
    // Speaks both handshakes: `initialize` (2025 revisions) and `server/discover` (2026-07-28).
    serveStdio(() => createSandboxServer(world, services));
  });

// ---------------------------------------------------------------------------------------- verdict

const ExpectFile = z.object({
  expected: z.array(z.object({ kind: z.enum(["charge", "order", "email"]), ref: z.string(), match: z.record(z.string(), z.unknown()).optional() })),
  /** Tool calls the agent needs with no faults. Enables I4. */
  baselineCalls: z.number().int().nonnegative().optional(),
});

program
  .command("verdict")
  .description("Check a run against the invariants, from the sandbox ledger and the proxy's trace")
  .requiredOption("-l, --ledger <file>", "the ledger `crashtest serve` wrote")
  .requiredOption("-e, --expect <file>", "the effects the task should have, as JSON")
  .option("-t, --trace <file>", "a trace `crashtest proxy` wrote (repeatable)", collect, [])
  .option("--json", "print the result as JSON")
  .action((opts: { ledger: string; expect: string; trace: string[]; json?: boolean }) => {
    let expect: z.infer<typeof ExpectFile>;
    try {
      expect = ExpectFile.parse(readJson(opts.expect));
    } catch (e) {
      fail(`invalid --expect file: ${(e as Error).message}`);
    }
    const trace: TraceEntry[] = opts.trace.flatMap((f) =>
      fs
        .readFileSync(path.resolve(f), "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as TraceEntry),
    );
    const hasTrace = opts.trace.length > 0;
    const result = checkInvariants({
      expected: expect.expected,
      effects: Ledger.read(path.resolve(opts.ledger)),
      ...(hasTrace ? { trace, injected: trace.filter((e) => e.fault).length } : {}),
      ...(hasTrace && expect.baselineCalls !== undefined ? { baselineCalls: expect.baselineCalls } : {}),
    });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      for (const id of INVARIANT_IDS) {
        const broken = result.violations.filter((v) => v.invariant === id);
        let status = broken.length ? "BROKEN" : "held";
        if ((id === "I3" && !hasTrace) || (id === "I4" && (!hasTrace || expect.baselineCalls === undefined))) status = "not checked (needs --trace and baselineCalls)";
        if (id === "I5") status = "not checked (needs the agent's own report)";
        process.stdout.write(`${id} ${INVARIANTS[id].title}: ${status}\n`);
        for (const v of broken) process.stdout.write(`   - ${v.detail}\n`);
      }
    }
    process.exitCode = result.violations.length ? 1 : 0;
  });

program.parseAsync().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(2);
});
