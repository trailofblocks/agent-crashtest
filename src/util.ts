import crypto from "node:crypto";

/** A small, fast, seeded PRNG (mulberry32). Same seed, same sequence, on every platform. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A hex id from a seeded generator, for deterministic keys and ids. */
export function randomHex(rand: () => number, bytes = 8): string {
  let out = "";
  for (let i = 0; i < bytes; i++) out += Math.floor(rand() * 256).toString(16).padStart(2, "0");
  return out;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** JSON with sorted keys, so equal values hash equally. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** `*` matches any run of characters, `?` one character. Everything else is literal. */
export function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

export function matchesGlob(glob: string, value: string): boolean {
  return globToRegExp(glob).test(value);
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
