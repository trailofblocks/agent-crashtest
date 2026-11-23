import { type AgentPolicy, POLICIES } from "./agents.js";

/** An agent policy, plus how the providers behave, for one column of a results table. */
export interface Variant {
  id: string;
  label: string;
  policy: AgentPolicy;
  /** Whether providers honor dedup keys. Default true. */
  dedup?: boolean;
}

export const AGENTS: Variant[] = [
  { id: "naive", label: "Naive retry loop", policy: POLICIES.naive },
  { id: "no-retry", label: "No retries (at-most-once)", policy: POLICIES["no-retry"] },
  { id: "framework", label: "Framework retry policy", policy: POLICIES.framework },
  { id: "idempotent", label: "Idempotent (recommended)", policy: POLICIES.idempotent },
];

/** The recommended agent, taken apart one piece at a time. */
export const ABLATION: Variant[] = [
  { id: "framework", label: "No keys (framework)", policy: POLICIES.framework },
  { id: "key-per-attempt", label: "New key per attempt", policy: { ...POLICIES.framework, keys: "per-attempt" } },
  { id: "key-in-memory", label: "Key in memory", policy: { ...POLICIES.framework, keys: "in-memory" } },
  { id: "idempotent", label: "Key in an outbox (full fix)", policy: POLICIES.idempotent },
  { id: "provider-ignores-keys", label: "Full fix, provider ignores keys", policy: POLICIES.idempotent, dedup: false },
  {
    id: "no-backoff",
    label: "Full fix, no backoff or Retry-After",
    policy: { ...POLICIES.idempotent, backoff: null, honorRetryAfter: false },
  },
];

export const ALL_VARIANTS: Variant[] = [...AGENTS, ...ABLATION.filter((a) => !AGENTS.some((b) => b.id === a.id))];

export function variantById(id: string): Variant {
  const v = ALL_VARIANTS.find((x) => x.id === id);
  if (!v) throw new Error(`unknown agent ${id}; choose from ${ALL_VARIANTS.map((x) => x.id).join(", ")}`);
  return v;
}
