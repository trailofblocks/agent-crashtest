import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { RealClock } from "../clock.js";
import { FaultEngine } from "../faults.js";
import { Ledger } from "../ledger.js";
import { FaultProxy } from "../proxy.js";
import { createSandboxServer } from "../sandbox/server.js";
import { SandboxWorld, SERVICES, type ServiceName } from "../sandbox/world.js";
import { readHello, SocketTransport } from "../transports.js";
import type { AgentReport } from "./agents.js";
import { DEFAULT_MAX_CRASHES, type RunRecord, type RunSpec } from "./harness.js";

const fromSource = import.meta.url.endsWith(".ts");
const ext = fromSource ? ".ts" : ".js";
export const AGENT_MAIN = fileURLToPath(new URL(`./agent-main${ext}`, import.meta.url));
const NODE_ARGS = fromSource ? ["--import", import.meta.resolve("tsx")] : [];
const CHILD_TIMEOUT_MS = 60_000;

/**
 * Run one agent through one workflow as a real child process. The harness hosts the tools and the
 * fault proxies, and the agent connects to them over TCP. A crash fault kills the process
 * (SIGKILL, or TerminateProcess on Windows), and the harness starts a new one that resumes from
 * the agent's state file. Only crash faults make sense here: everything else needs simulated time.
 */
export async function runInChildProcess(spec: RunSpec): Promise<RunRecord> {
  const maxCrashes = spec.maxCrashes ?? DEFAULT_MAX_CRASHES;
  const clock = new RealClock();
  const ledger = new Ledger();
  const world = new SandboxWorld(ledger, clock, { dedup: spec.variant.dedup });
  const engine = new FaultEngine(spec.plan, { allowCrash: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crashtest-"));
  const storeFile = path.join(dir, "agent-state.json");
  const closers: Array<() => Promise<unknown>> = [];
  let child: ChildProcess | undefined;
  let crashedThisLife = false;
  const start = Date.now();

  const tcp = net.createServer((socket) => {
    void (async () => {
      const { hello, rest } = await readHello(socket);
      const name = (JSON.parse(hello) as { server?: string }).server as ServiceName;
      if (!SERVICES.includes(name)) throw new Error(`unknown service ${String(name)}`);
      const sandbox = createSandboxServer(world, [name]);
      const [up, serverSide] = InMemoryTransport.createLinkedPair();
      await sandbox.connect(serverSide);
      const proxy = new FaultProxy(new SocketTransport(socket, rest), up, {
        server: name,
        engine,
        clock,
        closeUpstreamWithClient: false,
        onCrash: () => {
          crashedThisLife = true;
          child?.kill("SIGKILL");
        },
      });
      await proxy.start();
      closers.push(
        () => proxy.close(),
        () => sandbox.close(),
      );
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  const port = (tcp.address() as net.AddressInfo).port;

  let crashes = 0;
  let finished = false;
  let stopped: string | undefined;
  let report: AgentReport | undefined;
  try {
    for (let life = 0; ; life++) {
      crashedThisLife = false;
      const args = [
        ...NODE_ARGS,
        AGENT_MAIN,
        "--port",
        String(port),
        "--variant",
        spec.variant.id,
        "--workflow",
        spec.workflow.id,
        "--store",
        storeFile,
        "--seed",
        String((spec.seed ?? 1) * 1000 + life),
      ];
      const proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      child = proc;
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      proc.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      const timer = setTimeout(() => proc.kill("SIGKILL"), CHILD_TIMEOUT_MS);
      const code = await new Promise<number | null>((resolve) => proc.on("exit", (c) => resolve(c)));
      clearTimeout(timer);
      if (crashedThisLife) {
        crashes++;
        if (crashes > maxCrashes) {
          stopped = `gave up after ${crashes} crashes`;
          break;
        }
        continue;
      }
      if (code !== 0) throw new Error(`agent process exited with ${String(code)}:\n${stderr}`);
      const line = stdout.trim().split("\n").pop() ?? "";
      report = JSON.parse(line) as AgentReport;
      finished = true;
      break;
    }
  } finally {
    child = undefined;
    await Promise.allSettled(closers.map((c) => c()));
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return {
    variant: spec.variant.id,
    workflow: spec.workflow.id,
    finished,
    ...(stopped ? { stopped } : {}),
    crashes,
    ...(report ? { report } : {}),
    effects: [...ledger.effects],
    trace: engine.trace.map((e) => ({ ...e })),
    injected: engine.injected,
    elapsedMs: Date.now() - start,
  };
}
