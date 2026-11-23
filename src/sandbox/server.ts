import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Outcome, SandboxWorld, ServiceName } from "./world.js";

function reply(o: Outcome) {
  const text = JSON.stringify(o.body);
  if (o.isError) return { content: [{ type: "text" as const, text }], isError: true };
  return { content: [{ type: "text" as const, text }], structuredContent: o.body };
}

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

/**
 * Sandbox MCP tools in front of a SandboxWorld. Each service can run as its own server (as the lab
 * does, one per provider) or together in one server (`crashtest serve`, for a real agent).
 */
export function createSandboxServer(world: SandboxWorld, services: ServiceName[], name = services.length === 1 ? services[0]! : "sandbox"): McpServer {
  const server = new McpServer({ name: `crashtest-${name}`, version: "0.1.0" });

  if (services.includes("payments")) {
    server.registerTool(
      "create_charge",
      {
        description:
          "Charge a customer's card on file. Pass idempotency_key to make retries safe: repeating a key with the same arguments returns the first charge instead of charging again.",
        inputSchema: z.object({
          customer: z.string().describe("Customer id, e.g. cus_ada"),
          amount_cents: z.number().int().positive(),
          currency: z.string().optional().describe("Default usd"),
          reference: z.string().describe("What the charge is for, e.g. an invoice number"),
          idempotency_key: z.string().optional(),
        }),
        annotations: WRITE,
      },
      async (args) => reply(world.createCharge(args)),
    );
    server.registerTool(
      "list_charges",
      {
        description: "List charges, optionally for one customer or reference.",
        inputSchema: z.object({ customer: z.string().optional(), reference: z.string().optional() }),
        annotations: READ,
      },
      async (f) => reply({ body: { charges: world.list("charge", f) } }),
    );
  }

  if (services.includes("orders")) {
    server.registerTool(
      "create_order",
      {
        description:
          "Create an order. Pass client_order_id to make retries safe: repeating an id with the same arguments returns the existing order.",
        inputSchema: z.object({
          customer: z.string(),
          items: z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })).min(1),
          total_cents: z.number().int().nonnegative(),
          reference: z.string().describe("The cart or checkout this order comes from"),
          client_order_id: z.string().optional(),
        }),
        annotations: WRITE,
      },
      async (args) => reply(world.createOrder(args)),
    );
    server.registerTool(
      "list_orders",
      {
        description: "List orders, optionally for one customer or reference.",
        inputSchema: z.object({ customer: z.string().optional(), reference: z.string().optional() }),
        annotations: READ,
      },
      async (f) => reply({ body: { orders: world.list("order", f) } }),
    );
  }

  if (services.includes("email")) {
    server.registerTool(
      "send_email",
      {
        description:
          "Send an email. Pass idempotency_key to make retries safe: repeating a key with the same arguments returns the first message instead of sending again.",
        inputSchema: z.object({
          to: z.string(),
          subject: z.string(),
          body: z.string(),
          reference: z.string().describe("What the email is about, e.g. an invoice number"),
          idempotency_key: z.string().optional(),
        }),
        annotations: WRITE,
      },
      async (args) => reply(world.sendEmail(args)),
    );
    server.registerTool(
      "list_sent",
      {
        description: "List sent emails, optionally to one address or for one reference.",
        inputSchema: z.object({ to: z.string().optional(), reference: z.string().optional() }),
        annotations: READ,
      },
      async (f) => reply({ body: { emails: world.list("email", f) } }),
    );
  }
  return server;
}
