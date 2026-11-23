import fs from "node:fs";

/** A side effect a tool actually committed. Replays of an earlier result are not effects. */
export interface Effect {
  /** Order of commitment, from 1. */
  seq: number;
  /** Clock time of the commit. */
  t: number;
  service: string;
  kind: "charge" | "order" | "email";
  /** The business reference the call carried (an invoice, a cart). Expectations match on it. */
  ref: string;
  /** The id the service assigned. */
  id: string;
  data: Record<string, unknown>;
}

/**
 * The record of what really happened. Services append to it when they commit something. The agent
 * can't read or write it, so invariants never depend on what the agent says it did.
 */
export class Ledger {
  readonly effects: Effect[] = [];

  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) this.effects.push(...Ledger.read(file));
  }

  record(effect: Omit<Effect, "seq">): Effect {
    const e: Effect = { seq: this.effects.length + 1, ...effect };
    this.effects.push(e);
    if (this.file) fs.appendFileSync(this.file, `${JSON.stringify(e)}\n`, "utf8");
    return e;
  }

  static read(file: string): Effect[] {
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Effect);
  }
}
