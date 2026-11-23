// A scripted agent as its own process, for `lab --mode process`. It connects to the harness's tools
// over TCP, keeps its state in a file, and prints its report as one JSON line when it finishes. The
// harness kills it to inject a crash.
import fs from "node:fs";
import net from "node:net";
import { Client, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { RealClock } from "../clock.js";
import { SocketTransport } from "../transports.js";
import { seededRandom } from "../util.js";
import { type AgentRuntime, type CallResult, type Durable, ScriptedAgent } from "./agents.js";
import { textOf } from "./harness.js";
import { variantById } from "./variants.js";
import { workflowById } from "./workflows.js";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}

const port = Number(arg("port"));
const variant = variantById(arg("variant"));
const workflow = workflowById(arg("workflow"));
const storeFile = arg("store");
const rand = seededRandom(Number(arg("seed")));
const clock = new RealClock();

const clients: Record<string, Client> = {};
for (const server of new Set(workflow.steps.map((s) => s.server))) {
  const socket = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  socket.write(`${JSON.stringify({ server })}\n`);
  const client = new Client({ name: "crashtest-lab-agent", version: "0.1.0" });
  await client.connect(new SocketTransport(socket));
  clients[server] = client;
}

const runtime: AgentRuntime = {
  async call(server, tool, args, timeoutMs): Promise<CallResult> {
    try {
      const r = await clients[server]!.callTool({ name: tool, arguments: args }, { timeout: timeoutMs });
      return { kind: "reply", isError: r.isError === true, text: textOf(r) };
    } catch (e) {
      if (e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout) return { kind: "timeout" };
      return { kind: "error", message: (e as Error).message };
    }
  },
  async tools(server) {
    const res = await clients[server]!.listTools();
    return res.tools.map((t) => ({ name: t.name, idempotent: t.annotations?.idempotentHint === true }));
  },
  sleep: (ms) => clock.sleep(ms),
  random: () => rand(),
  async load() {
    if (!fs.existsSync(storeFile)) return undefined;
    return JSON.parse(fs.readFileSync(storeFile, "utf8")) as Durable;
  },
  async save(state) {
    // Write, then rename over the old file, so a kill never leaves half a file behind.
    const tmp = `${storeFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, storeFile);
  },
};

const report = await new ScriptedAgent(variant.policy).run(workflow, runtime);
process.stdout.write(`${JSON.stringify(report)}\n`);
await Promise.allSettled(Object.values(clients).map((c) => c.close()));
process.exit(0);
