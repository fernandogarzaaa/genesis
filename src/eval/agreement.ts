/**
 * Inter-rater agreement for human (and human-vs-machine) judgments.
 *
 * Cohen's κ (two raters, categorical labels) and Fleiss' κ (N raters)
 * discount raw percent-agreement by chance agreement from the marginals —
 * the same honesty discipline as Wilson intervals elsewhere in Genesis.
 * κ is descriptive, never a verdict: report it alongside N and let the
 * reader judge whether the judges agree enough to carry the claim.
 */

export interface KappaResult {
  readonly kappa: number | null;
  readonly n: number;
  readonly interpretation: string | null;
}

/** Landis–Koch bands, descriptive labels only. */
export function interpretKappa(kappa: number | null): string | null {
  if (kappa === null || !Number.isFinite(kappa)) return null;
  if (kappa < 0) return "systematic disagreement";
  if (kappa < 0.2) return "slight agreement";
  if (kappa < 0.4) return "fair agreement";
  if (kappa < 0.6) return "moderate agreement";
  if (kappa < 0.8) return "substantial agreement";
  return "near-perfect agreement";
}

/**
 * Cohen's κ over paired categorical labels. Null when there are no pairs
 * or chance agreement is 1 (e.g. both raters constant on one label —
 * agreement is then undefined, not perfect).
 */
export function cohenKappa(a: readonly unknown[], b: readonly unknown[]): KappaResult {
  const pairs: [string, string][] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === null || x === undefined || y === null || y === undefined) continue;
    pairs.push([String(x), String(y)]);
  }
  if (pairs.length === 0) return { kappa: null, n: 0, interpretation: null };
  const labels = [...new Set(pairs.flat())];
  const agree = pairs.filter(([x, y]) => x === y).length / pairs.length;
  let chance = 0;
  for (const label of labels) {
    const pa = pairs.filter(([x]) => x === label).length / pairs.length;
    const pb = pairs.filter(([, y]) => y === label).length / pairs.length;
    chance += pa * pb;
  }
  if (chance >= 1) return { kappa: null, n: pairs.length, interpretation: null };
  const kappa = (agree - chance) / (1 - chance);
  return { kappa: Math.round(kappa * 10000) / 10000, n: pairs.length, interpretation: interpretKappa(kappa) };
}

/**
 * Fleiss' κ for N raters: `table[i][j]` = raters assigning item i to
 * category j. Every row must sum to the same rater count; otherwise null
 * (ragged rating coverage is a data problem, not a computable κ).
 */
export function fleissKappa(table: readonly (readonly number[])[]): KappaResult {
  if (table.length === 0) return { kappa: null, n: 0, interpretation: null };
  const width = table[0]?.length ?? 0;
  if (width === 0) return { kappa: null, n: 0, interpretation: null };
  // Strict shape validation: identical nonzero widths plus finite,
  // nonnegative integer counts. Ragged/fractional/negative tables are a
  // data problem — return null rather than a meaningless κ.
  for (const row of table) {
    if (row.length !== width) return { kappa: null, n: table.length, interpretation: null };
    for (const c of row) {
      if (typeof c !== "number" || !Number.isFinite(c) || !Number.isInteger(c) || c < 0) {
        return { kappa: null, n: table.length, interpretation: null };
      }
    }
  }
  const rowSums = table.map((row) => row.reduce((x, y) => x + y, 0));
  const raters = rowSums[0] as number;
  if (raters < 2 || !rowSums.every((s) => s === raters)) {
    return { kappa: null, n: table.length, interpretation: null };
  }
  const items = table.length;
  const colSums = Array.from({ length: width }, (_, j) => table.reduce((s, row) => s + (row[j] ?? 0), 0));
  const chance = colSums.reduce((s, c) => s + (c / (items * raters)) ** 2, 0);
  let agree = 0;
  for (const row of table) {
    agree += row.reduce((s, c) => s + c * (c - 1), 0) / (raters * (raters - 1));
  }
  agree /= items;
  if (1 - chance === 0) return { kappa: null, n: items, interpretation: null };
  const kappa = (agree - chance) / (1 - chance);
  return { kappa: Math.round(kappa * 10000) / 10000, n: items, interpretation: interpretKappa(kappa) };
}
