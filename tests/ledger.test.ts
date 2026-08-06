import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adjudicate } from "../src/adjudicator/index.js";
import { Ledger, LedgerError } from "../src/ledger/ledger.js";
import { ZERO_HASH } from "../src/shared/canonical.js";
import { CLEAN_PRE_REGISTRATION, evidence, frozen } from "./helpers.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "genesis-ledger-"));
  path = join(dir, "ledger.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A clock that advances predictably so entry hashes are reproducible. */
function fixedClock(start = 1_770_000_000_000): () => number {
  let t = start;
  return () => (t += 1000);
}

describe("ledger chain", () => {
  it("starts from the zero hash", () => {
    const ledger = new Ledger(path, fixedClock());
    const entry = ledger.registerContract(frozen());
    expect(entry.prev_hash).toBe(ZERO_HASH);
    expect(entry.seq).toBe(1);
    ledger.close();
  });

  it("links each entry to its predecessor", () => {
    const ledger = new Ledger(path, fixedClock());
    const a = ledger.registerContract(frozen());
    const b = ledger.recordEvidence(evidence({ contract_hash: a.contract_hash ?? "x" }));
    expect(b.prev_hash).toBe(a.entry_hash);
    expect(b.seq).toBe(2);
    ledger.close();
  });

  it("verifies an intact chain", () => {
    const ledger = new Ledger(path, fixedClock());
    const contract = frozen();
    ledger.registerContract(contract);
    ledger.recordEvidence(evidence({ contract_hash: contract.contract_hash }));
    ledger.recordVerdict(
      adjudicate({ contract, evidence: [], preRegistration: CLEAN_PRE_REGISTRATION }),
    );

    const result = ledger.verifyChain();
    expect(result.ok).toBe(true);
    expect(result.entries).toBe(3);
    ledger.close();
  });

  it("reports an empty chain as intact", () => {
    const ledger = new Ledger(path, fixedClock());
    expect(ledger.verifyChain()).toMatchObject({ ok: true, entries: 0, head: null });
    ledger.close();
  });

  // The whole reason the chain exists: a SQLite file is editable, so tampering
  // must at least be detectable, and detectable at a specific point.
  it("detects an edited payload and names the sequence", () => {
    const ledger = new Ledger(path, fixedClock());
    const contract = frozen();
    ledger.registerContract(contract);
    ledger.recordEvidence(evidence({ contract_hash: contract.contract_hash }));
    ledger.recordEvidence(evidence({ contract_hash: contract.contract_hash }));
    ledger.close();

    const db = new Database(path);
    db.prepare("UPDATE ledger SET payload = ? WHERE seq = 2").run('{"tampered":true}');
    db.close();

    const reopened = new Ledger(path, fixedClock());
    const result = reopened.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(2);
    expect(result.reason).toContain("modified after it was written");
    reopened.close();
  });

  it("detects a deleted entry", () => {
    const ledger = new Ledger(path, fixedClock());
    const contract = frozen();
    ledger.registerContract(contract);
    ledger.recordEvidence(evidence({ contract_hash: contract.contract_hash }));
    ledger.recordEvidence(evidence({ contract_hash: contract.contract_hash }));
    ledger.close();

    const db = new Database(path);
    db.prepare("DELETE FROM ledger WHERE seq = 2").run();
    db.close();

    const reopened = new Ledger(path, fixedClock());
    const result = reopened.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(3);
    reopened.close();
  });

  it("detects a backdated timestamp", () => {
    const ledger = new Ledger(path, fixedClock());
    ledger.registerContract(frozen());
    ledger.close();

    const db = new Database(path);
    db.prepare("UPDATE ledger SET recorded_at = 0 WHERE seq = 1").run();
    db.close();

    const reopened = new Ledger(path, fixedClock());
    expect(reopened.verifyChain().ok).toBe(false);
    reopened.close();
  });
});

describe("ledger immutability", () => {
  it("refuses to register the same contract twice", () => {
    const ledger = new Ledger(path, fixedClock());
    const contract = frozen();
    ledger.registerContract(contract);
    expect(() => ledger.registerContract(contract)).toThrow(LedgerError);
    ledger.close();
  });

  it("keeps superseded outcome labels in the chain", () => {
    const ledger = new Ledger(path, fixedClock());
    const contract = frozen();
    ledger.registerContract(contract);

    const first = ledger.labelOutcome(contract.contract_hash, {
      label: "merged_clean",
      label_source: "manual",
      verdict_entry_hash: null,
      detail: {},
      supersedes: null,
    });
    ledger.labelOutcome(contract.contract_hash, {
      label: "reverted",
      label_source: "manual",
      verdict_entry_hash: null,
      detail: {},
      supersedes: first.entry_hash,
    });

    const labels = ledger.entries({ type: "OUTCOME_LABELED", contract_hash: contract.contract_hash });
    expect(labels).toHaveLength(2);
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  });
});

describe("artifacts", () => {
  it("round-trips content by digest", () => {
    const ledger = new Ledger(path, fixedClock());
    const digest = ledger.putArtifact("hello world");
    expect(ledger.getArtifact(digest)).toBe("hello world");
    ledger.close();
  });

  it("redacts before hashing, so the digest matches what is stored", () => {
    const ledger = new Ledger(path, fixedClock());
    const digest = ledger.putArtifact("token: ghp_abcdefghijklmnopqrstuvwxyz012345");
    const stored = ledger.getArtifact(digest);

    expect(stored).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(stored).toContain("[REDACTED]");
    ledger.close();
  });

  it("deduplicates identical content", () => {
    const ledger = new Ledger(path, fixedClock());
    expect(ledger.putArtifact("same")).toBe(ledger.putArtifact("same"));
    ledger.close();
  });
});

describe("export", () => {
  it("emits one JSON object per entry", () => {
    const ledger = new Ledger(path, fixedClock());
    const contract = frozen();
    ledger.registerContract(contract);
    ledger.recordEvidence(evidence({ contract_hash: contract.contract_hash }));

    const lines = [...ledger.exportJsonl()];
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ seq: 1, entry_type: "CONTRACT_REGISTERED" });
    ledger.close();
  });
});
