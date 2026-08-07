/**
 * The ledger: hash-chained, append-only, single-writer.
 *
 * v1's `audit_log` was an ordinary SQLite table whose `timestamp` column was
 * supplied by its writer, and any process holding the file handle could edit a
 * verdict or backdate a contract. The ledger is the stated long-term asset —
 * the calibration data — and an asset that can be silently edited is not an
 * audit record.
 *
 * Chaining does not make tampering impossible; a local file with a determined
 * owner never can be. It makes tampering *detectable*, which is the achievable
 * and sufficient property. `verifyChain()` reports the exact `seq` where the
 * chain breaks.
 *
 * Every write goes through `#append`. There is no other path — the
 * choke-point discipline `adam-governance` documents and v1 lacked.
 */

import Database from "better-sqlite3";
import { canonicalize, hashCanonical, sha256, ZERO_HASH } from "../shared/canonical.js";
import { redact } from "../shared/redact.js";
import type { Adjudication } from "../adjudicator/index.js";
import type { Evidence } from "../evidence/envelope.js";
import type { FrozenContract } from "../contract/schema.js";

export type EntryType =
  | "CONTRACT_REGISTERED"
  | "CONTRACT_AMENDED"
  | "EVIDENCE_RECORDED"
  | "VERDICT_RENDERED"
  | "OUTCOME_LABELED"
  /** An assurance audit of a verifier under test. See src/assurance/. */
  | "VERIFIER_AUDITED";

export type OutcomeLabel = "merged_clean" | "reverted" | "hotfixed" | "rejected";

export interface LedgerEntry {
  readonly seq: number;
  readonly prev_hash: string;
  readonly entry_hash: string;
  readonly entry_type: EntryType;
  readonly contract_hash: string | null;
  readonly payload: unknown;
  readonly recorded_at: number;
}

export interface OutcomePayload {
  readonly label: OutcomeLabel;
  readonly label_source: "github_webhook" | "manual" | "backfill";
  readonly verdict_entry_hash: string | null;
  readonly detail: Record<string, unknown>;
  /** `entry_hash` of a prior label this one replaces. Labels are never edited. */
  readonly supersedes: string | null;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ledger (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    prev_hash     TEXT NOT NULL,
    entry_hash    TEXT NOT NULL UNIQUE,
    entry_type    TEXT NOT NULL,
    contract_hash TEXT,
    payload       TEXT NOT NULL,
    recorded_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_contract ON ledger(contract_hash);
  CREATE INDEX IF NOT EXISTS idx_ledger_type ON ledger(entry_type, seq);

  CREATE TABLE IF NOT EXISTS artifacts (
    digest      TEXT PRIMARY KEY,
    content     BLOB NOT NULL,
    size_bytes  INTEGER NOT NULL,
    stored_at   INTEGER NOT NULL
  );
`;

export class Ledger {
  readonly #db: Database.Database;
  /** Injected so tests are deterministic; production passes `Date.now`. */
  readonly #now: () => number;

  constructor(path = ":memory:", now: () => number = Date.now) {
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    this.#db.exec(SCHEMA);
    this.#now = now;
  }

  close(): void {
    this.#db.close();
  }

  // ── The single write path ─────────────────────────────────────────────────

  #append(entry_type: EntryType, contract_hash: string | null, payload: unknown): LedgerEntry {
    const tx = this.#db.transaction((): LedgerEntry => {
      const head = this.#db
        .prepare("SELECT seq, entry_hash FROM ledger ORDER BY seq DESC LIMIT 1")
        .get() as { seq: number; entry_hash: string } | undefined;

      const seq = (head?.seq ?? 0) + 1;
      const prev_hash = head?.entry_hash ?? ZERO_HASH;
      const recorded_at = this.#now();

      const entry_hash = computeEntryHash({
        seq,
        prev_hash,
        entry_type,
        contract_hash,
        payload,
        recorded_at,
      });

      this.#db
        .prepare(
          `INSERT INTO ledger (seq, prev_hash, entry_hash, entry_type, contract_hash, payload, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(seq, prev_hash, entry_hash, entry_type, contract_hash, canonicalize(payload), recorded_at);

      return { seq, prev_hash, entry_hash, entry_type, contract_hash, payload, recorded_at };
    });

    return tx.immediate();
  }

  // ── Typed writes ──────────────────────────────────────────────────────────

  registerContract(contract: FrozenContract): LedgerEntry {
    const existing = this.getContract(contract.contract_hash);
    if (existing) {
      throw new LedgerError(
        `contract ${contract.contract_hash.slice(0, 12)} is already registered (seq ${existing.seq}); ` +
          "contracts are immutable — use `genesis contract amend` to supersede it",
      );
    }
    const type: EntryType = contract.supersedes ? "CONTRACT_AMENDED" : "CONTRACT_REGISTERED";
    return this.#append(type, contract.contract_hash, contract);
  }

  recordEvidence(record: Evidence): LedgerEntry {
    return this.#append("EVIDENCE_RECORDED", record.contract_hash, record);
  }

  recordVerdict(adjudication: Adjudication, context: Record<string, unknown> = {}): LedgerEntry {
    return this.#append("VERDICT_RENDERED", adjudication.contract_hash, {
      ...adjudication,
      context,
    });
  }

  labelOutcome(contract_hash: string, payload: OutcomePayload): LedgerEntry {
    return this.#append("OUTCOME_LABELED", contract_hash, payload);
  }

  /**
   * Record an assurance audit of a verifier.
   *
   * `subject_hash` identifies the (verifier, suite) pair rather than a contract.
   * Chaining these matters for the same reason it matters for verdicts: "we
   * audited this verifier on that date and it was clean" is a claim someone may
   * later want to have been true, and an editable record cannot support it.
   */
  recordVerifierAudit(subject_hash: string, payload: unknown): LedgerEntry {
    return this.#append("VERIFIER_AUDITED", subject_hash, payload);
  }

  // ── Artifacts ─────────────────────────────────────────────────────────────

  /**
   * Store a collector artifact, redacted, and return its digest.
   *
   * Redaction happens before hashing. Redacting afterwards would leave the
   * digest certifying content that is no longer what is stored.
   */
  putArtifact(content: string): string {
    const clean = redact(content);
    const digest = sha256(clean);
    this.#db
      .prepare(
        `INSERT INTO artifacts (digest, content, size_bytes, stored_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(digest) DO NOTHING`,
      )
      .run(digest, Buffer.from(clean, "utf8"), Buffer.byteLength(clean), this.#now());
    return digest;
  }

  getArtifact(digest: string): string | null {
    const row = this.#db
      .prepare("SELECT content FROM artifacts WHERE digest = ?")
      .get(digest) as { content: Buffer } | undefined;
    return row ? row.content.toString("utf8") : null;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  entries(filter: { type?: EntryType; contract_hash?: string } = {}): LedgerEntry[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.type) {
      clauses.push("entry_type = ?");
      params.push(filter.type);
    }
    if (filter.contract_hash) {
      clauses.push("contract_hash = ?");
      params.push(filter.contract_hash);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(`SELECT * FROM ledger ${where} ORDER BY seq ASC`)
      .all(...params) as RawRow[];
    return rows.map(toEntry);
  }

  getContract(contract_hash: string): (LedgerEntry & { payload: FrozenContract }) | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM ledger
         WHERE contract_hash = ? AND entry_type IN ('CONTRACT_REGISTERED','CONTRACT_AMENDED')
         ORDER BY seq ASC LIMIT 1`,
      )
      .get(contract_hash) as RawRow | undefined;
    if (!row) return null;
    return toEntry(row) as LedgerEntry & { payload: FrozenContract };
  }

  head(): LedgerEntry | null {
    const row = this.#db
      .prepare("SELECT * FROM ledger ORDER BY seq DESC LIMIT 1")
      .get() as RawRow | undefined;
    return row ? toEntry(row) : null;
  }

  size(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM ledger").get() as { n: number };
    return row.n;
  }

  /** Distinct contract hashes, oldest first. */
  contractHashes(): string[] {
    const rows = this.#db
      .prepare(
        `SELECT contract_hash FROM ledger
         WHERE entry_type IN ('CONTRACT_REGISTERED','CONTRACT_AMENDED')
         ORDER BY seq ASC`,
      )
      .all() as Array<{ contract_hash: string }>;
    return rows.map((r) => r.contract_hash);
  }

  // ── Integrity ─────────────────────────────────────────────────────────────

  verifyChain(): ChainVerification {
    const rows = this.#db.prepare("SELECT * FROM ledger ORDER BY seq ASC").all() as RawRow[];

    let expectedPrev = ZERO_HASH;
    let expectedSeq = 1;

    for (const row of rows) {
      const entry = toEntry(row);

      if (entry.seq !== expectedSeq) {
        return broken(entry.seq, `sequence gap: expected seq ${expectedSeq}, found ${entry.seq}`, rows.length);
      }
      if (entry.prev_hash !== expectedPrev) {
        return broken(entry.seq, `broken link: prev_hash does not match seq ${entry.seq - 1}`, rows.length);
      }

      const recomputed = computeEntryHash(entry);
      if (recomputed !== entry.entry_hash) {
        return broken(
          entry.seq,
          `entry_hash mismatch: stored ${entry.entry_hash.slice(0, 12)}, recomputed ${recomputed.slice(0, 12)} ` +
            "— this entry's contents were modified after it was written",
          rows.length,
        );
      }

      expectedPrev = entry.entry_hash;
      expectedSeq += 1;
    }

    return { ok: true, entries: rows.length, head: expectedPrev === ZERO_HASH ? null : expectedPrev };
  }

  /** Full ledger as JSONL, for backup and out-of-band verification. */
  *exportJsonl(): Generator<string> {
    for (const entry of this.entries()) {
      yield JSON.stringify(entry);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export class LedgerError extends Error {
  override readonly name = "LedgerError";
}

export interface ChainVerification {
  readonly ok: boolean;
  readonly entries: number;
  readonly head?: string | null;
  readonly brokenAt?: number;
  readonly reason?: string;
}

interface RawRow {
  seq: number;
  prev_hash: string;
  entry_hash: string;
  entry_type: string;
  contract_hash: string | null;
  payload: string;
  recorded_at: number;
}

function toEntry(row: RawRow): LedgerEntry {
  return {
    seq: row.seq,
    prev_hash: row.prev_hash,
    entry_hash: row.entry_hash,
    entry_type: row.entry_type as EntryType,
    contract_hash: row.contract_hash,
    payload: JSON.parse(row.payload) as unknown,
    recorded_at: row.recorded_at,
  };
}

/** The hash input. Everything except `entry_hash` itself. */
export function computeEntryHash(entry: Omit<LedgerEntry, "entry_hash">): string {
  return hashCanonical({
    seq: entry.seq,
    prev_hash: entry.prev_hash,
    entry_type: entry.entry_type,
    contract_hash: entry.contract_hash,
    payload: entry.payload,
    recorded_at: entry.recorded_at,
  });
}

function broken(seq: number, reason: string, entries: number): ChainVerification {
  return { ok: false, entries, brokenAt: seq, reason };
}
