import type { Clock } from "../clock.js";
import { type Effect, Ledger } from "../ledger.js";
import { canonicalJson, sha256 } from "../util.js";

export type ServiceName = "payments" | "orders" | "email";
export const SERVICES: ServiceName[] = ["payments", "orders", "email"];

export interface WorldOptions {
  /**
   * Whether each service honors its dedup key (`idempotency_key`, or `client_order_id` for orders).
   * Default true. Turn it off to model a provider that ignores keys.
   */
  dedup?: boolean | Partial<Record<ServiceName, boolean>>;
}

export interface Outcome {
  body: Record<string, unknown>;
  isError?: boolean;
}

export interface ChargeArgs {
  customer: string;
  amount_cents: number;
  currency?: string;
  reference: string;
  idempotency_key?: string;
}

export interface OrderArgs {
  customer: string;
  items: Array<{ sku: string; qty: number }>;
  total_cents: number;
  reference: string;
  client_order_id?: string;
}

export interface EmailArgs {
  to: string;
  subject: string;
  body: string;
  reference: string;
  idempotency_key?: string;
}

interface SavedKey {
  argsHash: string;
  response: Record<string, unknown>;
}

const PREFIX: Record<Effect["kind"], string> = { charge: "ch", order: "ord", email: "msg" };

/**
 * The state behind the sandbox tools: a payment processor, an order system, and an email provider.
 * Every committed effect goes to the ledger. Dedup keys follow the common payment-API pattern: the
 * same key with the same arguments returns the first result and commits nothing; the same key with
 * different arguments is refused.
 */
export class SandboxWorld {
  private keys = new Map<string, SavedKey>();

  constructor(
    readonly ledger: Ledger,
    readonly clock: Clock,
    private readonly opts: WorldOptions = {},
  ) {
    // A restarted `crashtest serve` remembers keys from the ledger, as a real provider would.
    for (const e of ledger.effects) {
      const k = e.data.dedup_key;
      if (typeof k === "string" && typeof e.data.args_hash === "string") {
        this.keys.set(`${e.service}:${k}`, { argsHash: e.data.args_hash, response: this.responseFor(e) });
      }
    }
  }

  dedupOn(service: ServiceName): boolean {
    const d = this.opts.dedup;
    if (d === undefined) return true;
    if (typeof d === "boolean") return d;
    return d[service] ?? true;
  }

  private responseFor(e: Effect): Record<string, unknown> {
    const { dedup_key: _k, args_hash: _h, ...rest } = e.data;
    return { id: e.id, object: e.kind, ...rest, reference: e.ref, created: e.t };
  }

  private commit(
    service: ServiceName,
    kind: Effect["kind"],
    dedupKey: string | undefined,
    args: Record<string, unknown>,
    fields: Record<string, unknown>,
  ): Outcome {
    const argsHash = sha256(canonicalJson(args));
    const useKey = dedupKey !== undefined && dedupKey !== "" && this.dedupOn(service);
    if (useKey) {
      const saved = this.keys.get(`${service}:${dedupKey}`);
      if (saved) {
        if (saved.argsHash !== argsHash) {
          return {
            isError: true,
            body: { error: "idempotency_key_reused", status: 422, message: `Key ${dedupKey} was already used with different arguments.` },
          };
        }
        return { body: { ...saved.response, idempotent_replayed: true } };
      }
    }
    const n = this.ledger.effects.filter((e) => e.kind === kind).length + 1;
    const effect = this.ledger.record({
      t: this.clock.now(),
      service,
      kind,
      ref: String(args.reference),
      id: `${PREFIX[kind]}_${String(n).padStart(4, "0")}`,
      data: { ...fields, ...(useKey ? { dedup_key: dedupKey, args_hash: argsHash } : {}) },
    });
    const response = this.responseFor(effect);
    if (useKey) this.keys.set(`${service}:${dedupKey}`, { argsHash, response });
    return { body: response };
  }

  createCharge(a: ChargeArgs): Outcome {
    const { idempotency_key, ...args } = a;
    const currency = args.currency ?? "usd";
    return this.commit("payments", "charge", idempotency_key, { ...args, currency }, {
      status: "succeeded",
      customer: args.customer,
      amount_cents: args.amount_cents,
      currency,
    });
  }

  createOrder(a: OrderArgs): Outcome {
    const { client_order_id, ...args } = a;
    return this.commit("orders", "order", client_order_id, args, {
      status: "created",
      customer: args.customer,
      items: args.items,
      total_cents: args.total_cents,
    });
  }

  sendEmail(a: EmailArgs): Outcome {
    const { idempotency_key, ...args } = a;
    return this.commit("email", "email", idempotency_key, args, {
      status: "queued",
      to: args.to,
      subject: args.subject,
      body: args.body,
    });
  }

  list(kind: Effect["kind"], filter: { reference?: string; customer?: string; to?: string }): Record<string, unknown>[] {
    return this.ledger.effects
      .filter((e) => e.kind === kind)
      .filter((e) => filter.reference === undefined || e.ref === filter.reference)
      .filter((e) => filter.customer === undefined || e.data.customer === filter.customer)
      .filter((e) => filter.to === undefined || e.data.to === filter.to)
      .map((e) => this.responseFor(e));
  }
}
