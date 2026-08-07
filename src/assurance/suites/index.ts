/**
 * Suite registry.
 *
 * Adding a defect class means adding probes here and nothing else — the audit
 * runner and the pure conclusion logic never learn their names.
 */

import type { ProbeSuite } from "../probe.js";
import { codeSuite } from "./code.js";
import { jsonSuite } from "./json.js";
import { mathSuite } from "./math.js";

export const SUITES: Readonly<Record<string, ProbeSuite>> = {
  code: codeSuite,
  json: jsonSuite,
  math: mathSuite,
};

export function suiteNames(): string[] {
  return Object.keys(SUITES).sort();
}

export function getSuite(name: string): ProbeSuite | undefined {
  return SUITES[name];
}

export { codeSuite, jsonSuite, mathSuite };
