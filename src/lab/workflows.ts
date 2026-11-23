import type { Effect } from "../ledger.js";
import { dollars } from "../util.js";

/** One side effect the task needs, as the ledger should record it: exactly once. */
export interface ExpectedEffect {
  kind: Effect["kind"];
  ref: string;
  /** Fields the committed effect must carry. */
  match?: Record<string, unknown>;
}

export interface Step {
  id: string;
  server: string;
  tool: string;
  /** The tool argument that carries a dedup key, if the agent uses one. */
  keyField: string;
  /** Steps whose results this one needs. If any of them failed, this one is skipped. */
  needs?: string[];
  /** Arguments, from the outputs of earlier steps. */
  args(outputs: Record<string, Record<string, unknown>>): Record<string, unknown>;
  expect: ExpectedEffect;
}

export interface Workflow {
  id: string;
  title: string;
  steps: Step[];
}

const checkout: Workflow = {
  id: "checkout",
  title: "Checkout: create the order, charge the card, email a receipt",
  steps: [
    {
      id: "order",
      server: "orders",
      tool: "create_order",
      keyField: "client_order_id",
      args: () => ({
        customer: "cus_ada",
        items: [
          { sku: "kettle-01", qty: 1 },
          { sku: "filter-12", qty: 2 },
        ],
        total_cents: 5800,
        reference: "cart_7781",
      }),
      expect: { kind: "order", ref: "cart_7781", match: { total_cents: 5800 } },
    },
    {
      id: "charge",
      server: "payments",
      tool: "create_charge",
      keyField: "idempotency_key",
      needs: ["order"],
      args: () => ({ customer: "cus_ada", amount_cents: 5800, currency: "usd", reference: "cart_7781" }),
      expect: { kind: "charge", ref: "cart_7781", match: { amount_cents: 5800 } },
    },
    {
      id: "receipt",
      server: "email",
      tool: "send_email",
      keyField: "idempotency_key",
      needs: ["order", "charge"],
      args: (o) => ({
        to: "ada@example.com",
        subject: `Your receipt for order ${String(o.order?.id)}`,
        body: `We charged ${dollars(5800)} to your card (charge ${String(o.charge?.id)}). Thanks for your order.`,
        reference: "cart_7781",
      }),
      expect: { kind: "email", ref: "cart_7781" },
    },
  ],
};

const CUSTOMERS = [
  { customer: "cus_ada", email: "ada@example.com", invoice: "inv_2001", cents: 4900 },
  { customer: "cus_grace", email: "grace@example.com", invoice: "inv_2002", cents: 12900 },
  { customer: "cus_alan", email: "alan@example.com", invoice: "inv_2003", cents: 4900 },
  { customer: "cus_edsger", email: "edsger@example.com", invoice: "inv_2004", cents: 29900 },
  { customer: "cus_barbara", email: "barbara@example.com", invoice: "inv_2005", cents: 4900 },
];

const billing: Workflow = {
  id: "billing",
  title: "Billing run: charge five customers, email each a receipt",
  steps: CUSTOMERS.flatMap((c) => [
    {
      id: `charge-${c.invoice}`,
      server: "payments",
      tool: "create_charge",
      keyField: "idempotency_key",
      args: () => ({ customer: c.customer, amount_cents: c.cents, currency: "usd", reference: c.invoice }),
      expect: { kind: "charge" as const, ref: c.invoice, match: { amount_cents: c.cents } },
    },
    {
      id: `receipt-${c.invoice}`,
      server: "email",
      tool: "send_email",
      keyField: "idempotency_key",
      needs: [`charge-${c.invoice}`],
      args: (o: Record<string, Record<string, unknown>>) => ({
        to: c.email,
        subject: `Receipt for ${c.invoice}`,
        body: `We charged ${dollars(c.cents)} (charge ${String(o[`charge-${c.invoice}`]?.id)}).`,
        reference: c.invoice,
      }),
      expect: { kind: "email" as const, ref: c.invoice },
    },
  ]),
};

export const WORKFLOWS: Workflow[] = [checkout, billing];

export function workflowById(id: string): Workflow {
  const w = WORKFLOWS.find((x) => x.id === id);
  if (!w) throw new Error(`unknown workflow ${id}`);
  return w;
}

export function expectedEffects(w: Workflow): ExpectedEffect[] {
  return w.steps.map((s) => s.expect);
}
