/**
 * Purity is enforced by a failing test, not by a convention.
 *
 * `adjudicate()` is pure on day one. Then someone needs the current time for a
 * staleness check, or a config lookup for a threshold, or a network call to
 * resolve a CVE severity. Each is individually reasonable, and the end state is
 * that replaying the ledger produces different verdicts than it did originally
 * — which makes the calibration dataset uninterpretable, because you can no
 * longer tell whether a verdict changed due to the evidence or due to the
 * verifier.
 *
 * This test is cheap to satisfy now and would be contentious to add later.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ADJUDICATOR_DIR = new URL("../src/adjudicator/", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

/** Modules the pure core may import. Types only, plus its own siblings. */
const ALLOWED_IMPORTS = [
  "../contract/schema.js",
  "../evidence/envelope.js",
  "./expect.js",
  "./index.js",
];

const FORBIDDEN_GLOBALS = [
  // Non-determinism.
  /\bDate\.now\s*\(/,
  /\bnew\s+Date\s*\(/,
  /\bMath\.random\s*\(/,
  /\bperformance\.now\s*\(/,
  // I/O and ambient configuration.
  /\bprocess\.(env|argv|cwd)\b/,
  /\brequire\s*\(/,
  /\bfetch\s*\(/,
  /\bglobalThis\b/,
];

describe("adjudicator purity", () => {
  const files = sourceFiles(ADJUDICATOR_DIR);

  it("has source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const name = file.split("/").at(-1) ?? file;
    const source = readFileSync(file, "utf8");

    it(`${name} imports no Node built-ins`, () => {
      const nodeImports = [...source.matchAll(/from\s+["'](node:[^"']+)["']/g)].map((m) => m[1]);
      expect(nodeImports).toEqual([]);
    });

    it(`${name} imports only from the allowed pure surface`, () => {
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
      const disallowed = imports.filter((spec) => !ALLOWED_IMPORTS.includes(spec));
      expect(disallowed).toEqual([]);
    });

    it(`${name} imports no runtime values from outside the core`, () => {
      // `import type` is erased at compile time and cannot introduce impurity.
      const valueImports = [...source.matchAll(/^import\s+(?!type\b)([^;]+?)\s+from\s+["']([^"']+)["']/gm)]
        .map((m) => m[2] ?? "")
        .filter((spec) => !spec.startsWith("./"));
      expect(valueImports).toEqual([]);
    });

    it(`${name} touches no clock, randomness, or ambient state`, () => {
      const hits = FORBIDDEN_GLOBALS.filter((re) => re.test(source)).map((re) => re.source);
      expect(hits).toEqual([]);
    });
  }
});
