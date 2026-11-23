// The CLI as a user runs it: real processes, stdio, and files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const NODE = [process.execPath, "--import", import.meta.resolve("tsx")];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crashtest-cli-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function crashtest(...args: string[]) {
  const r = spawnSync(NODE[0]!, [...NODE.slice(1), CLI, ...args], { encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("crashtest lab", () => {
  test("prints the table and exits 0 when the idempotent agent holds", () => {
    const r = crashtest("lab", "--agents", "framework,idempotent", "--faults", "F1,F9", "--chaos", "0");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\| \*\*F1\*\* \| Lost response \| \*\*I1\*\* 13\/13 \| held \| I1 \|/);
    assert.match(r.out, /\| \*\*F9\*\* \| Crash after the effect \| \*\*I1\*\* 13\/13 \| held \| I1 \|/);
  });

  test("exits 1 when the gated agent breaks an invariant", () => {
    // The full fix, against a provider that ignores keys: duplicate delivery double-charges.
    const r = crashtest("lab", "--agents", "provider-ignores-keys", "--gate", "provider-ignores-keys", "--faults", "F3", "--chaos", "0");
    assert.equal(r.code, 1);
    assert.match(r.err, /The provider-ignores-keys agent broke an invariant in 13 run\(s\)/);
  });

  test("--json prints every run", () => {
    const r = crashtest("lab", "--agents", "idempotent", "--faults", "F3", "--chaos", "0", "--json");
    assert.equal(r.code, 0, r.err);
    const json = JSON.parse(r.out);
    assert.equal(json.sweep.length, 13);
    assert.ok(json.sweep.every((x: { violations: unknown[] }) => x.violations.length === 0));
  });

  test("rejects unknown faults", () => {
    const r = crashtest("lab", "--faults", "F42");
    assert.notEqual(r.code, 0);
    assert.match(r.err, /unknown fault F42/);
  });
});

describe("crashtest proxy + serve + verdict, driven by the SDK client over stdio", () => {
  const charge = { customer: "cus_ada", amount_cents: 4900, reference: "inv_1001" };
  const expectFile = path.join(dir, "expect.json");
  fs.writeFileSync(expectFile, JSON.stringify({ expected: [{ kind: "charge", ref: "inv_1001", match: { amount_cents: 4900 } }], baselineCalls: 1 }));

  /** One session: a client that retries once after a timeout, like the framework agent. */
  async function session(name: string, withKey: boolean) {
    const ledger = path.join(dir, `${name}-ledger.jsonl`);
    const trace = path.join(dir, `${name}-trace.jsonl`);
    const plan = JSON.stringify({ rules: [{ tool: "sandbox/create_charge", fault: "lost_response" }] });
    const transport = new StdioClientTransport({
      command: NODE[0]!,
      args: [...NODE.slice(1), CLI, "proxy", "--name", "sandbox", "--faults", plan, "--trace", trace, "--quiet", "--", ...NODE, CLI, "serve", "--ledger", ledger],
      env: getDefaultEnvironment(),
      stderr: "pipe",
    });
    const client = new Client({ name: "cli-test", version: "1.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["create_charge", "list_charges", "create_order", "list_orders", "send_email", "list_sent"],
    );
    const args = withKey ? { ...charge, idempotency_key: "ik_test_1" } : charge;
    await assert.rejects(client.callTool({ name: "create_charge", arguments: args }, { timeout: 1500 }), (e: unknown) => e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout);
    const retry = await client.callTool({ name: "create_charge", arguments: args }, { timeout: 10_000 });
    assert.equal(retry.isError, undefined);
    await client.close();
    return { ledger, trace };
  }

  test("a retry without a key double-charges, and verdict says so", async () => {
    const { ledger, trace } = await session("plain", false);
    const v = crashtest("verdict", "--ledger", ledger, "--expect", expectFile, "--trace", trace);
    assert.equal(v.code, 1, v.err);
    assert.match(v.out, /I1 Exactly once: BROKEN\n {3}- charge for inv_1001 committed 2 times \(\$49\.00 \+ \$49\.00\)/);
    assert.match(v.out, /I2 Nothing lost: held/);
    assert.match(v.out, /I4 Bounded extra cost: held/);
    assert.match(v.out, /I5 Honest report: not checked/);
    const lines = fs.readFileSync(trace, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.map((l) => [l.n, l.fault, l.outcome]),
      [
        [1, "lost_response", "dropped"],
        [2, null, "delivered"],
      ],
    );
  });

  test("a retry with the same key charges once, and verdict passes", async () => {
    const { ledger, trace } = await session("keyed", true);
    const v = crashtest("verdict", "--ledger", ledger, "--expect", expectFile, "--trace", trace, "--json");
    assert.equal(v.code, 0, v.out);
    assert.deepEqual(JSON.parse(v.out).violations, []);
    assert.equal(fs.readFileSync(ledger, "utf8").trim().split("\n").length, 1);
  });

  test("the proxy refuses crash faults: it doesn't own the agent's process", () => {
    const r = crashtest("proxy", "--faults", '{"rules":[{"fault":"crash_after"}]}', "--", "node", "-e", "0");
    assert.equal(r.code, 2);
    assert.match(r.err, /needs a harness that owns the agent's process/);
  });
});
