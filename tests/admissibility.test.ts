import { describe, expect, it } from "vitest";
import { filterAdmissible, inadmissibleReason } from "../src/evidence/admissibility.js";
import { evidence } from "./helpers.js";

describe("admissibility — the executor cannot grade itself", () => {
  it("admits evidence Genesis produced", () => {
    expect(inadmissibleReason(evidence())).toBeNull();
  });

  it("admits evidence attested by a CI provider", () => {
    const record = evidence({
      provenance: { ...evidence().provenance, produced_by: "attested_ci" },
    });
    expect(inadmissibleReason(record)).toBeNull();
  });

  it("rejects evidence the executor produced", () => {
    const record = evidence({
      provenance: { ...evidence().provenance, produced_by: "executor" },
    });
    expect(inadmissibleReason(record)).toContain("cannot grade itself");
  });

  it("rejects an unrecognized provenance", () => {
    const record = evidence({
      provenance: {
        ...evidence().provenance,
        produced_by: "trust_me" as unknown as "genesis",
      },
    });
    expect(inadmissibleReason(record)).toContain("unknown provenance");
  });

  it("rejects behavioral evidence with no recorded seed", () => {
    // Evidence that cannot be reproduced cannot be re-adjudicated when the
    // ledger is replayed, which is the whole point of keeping the ledger.
    const record = evidence({ kind: "behavioral", provenance: { ...evidence().provenance, seed: null } });
    expect(inadmissibleReason(record)).toContain("not reproducible");
  });

  it("admits behavioral evidence that recorded its seed", () => {
    const record = evidence({ kind: "behavioral", provenance: { ...evidence().provenance, seed: 4711 } });
    expect(inadmissibleReason(record)).toBeNull();
  });

  it("does not demand a seed from a behavioral collector that failed to run", () => {
    const record = evidence({
      kind: "behavioral",
      status: "error",
      provenance: { ...evidence().provenance, seed: null },
    });
    expect(inadmissibleReason(record)).toBeNull();
  });

  it("partitions a mixed batch and explains each rejection", () => {
    const good = evidence();
    const bad = evidence({ provenance: { ...evidence().provenance, produced_by: "executor" } });

    const ruling = filterAdmissible([good, bad]);
    expect(ruling.admissible).toHaveLength(1);
    expect(ruling.rejected).toHaveLength(1);
    expect(ruling.rejected[0]?.reason).toBeTruthy();
  });
});
