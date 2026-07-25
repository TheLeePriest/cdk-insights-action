import * as path from 'node:path';

/** Suffix the CLI appends to every report file: `{stack}_analysis_report.<ext>`. */
export const REPORT_SUFFIX = '_analysis_report';

/** Basename of the cross-stack SARIF the CLI writes in multi-stack runs. */
export const CONSOLIDATED_SARIF = `consolidated${REPORT_SUFFIX}.sarif`;

/** First CLI version that supports single-pass `--reports` output. */
export const REPORTS_FLAG_MIN_VERSION = '1.44.0';

/**
 * Compare two semver-ish strings on their numeric major.minor.patch core
 * (pre-release suffixes are ignored). Returns true when `version` >= `min`.
 * Used to gate features the action relies on in newer CLI releases.
 */
export function versionGte(version: string, min: string): boolean {
  const core3 = (v: string): [number, number, number] => {
    const [maj, minr, pat] = v
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
    return [maj, minr, pat];
  };
  const [a, b, c] = core3(version);
  const [x, y, z] = core3(min);
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c >= z;
}

/**
 * Pick the SARIF file(s) to act on, avoiding duplicate findings.
 *
 * In multi-stack (`--all`) mode the CLI writes one `{stack}_analysis_report.sarif`
 * per stack AND a `consolidated_analysis_report.sarif` that is the union of all
 * of them. Uploading every file to Code Scanning would push the same findings
 * twice. When the consolidated file is present we use only it; otherwise (single
 * stack) we use the per-stack file(s).
 */
export function selectSarifFiles(sarifFiles: string[]): string[] {
  const consolidated = sarifFiles.find(
    (f) => path.basename(f) === CONSOLIDATED_SARIF,
  );
  return consolidated ? [consolidated] : sarifFiles;
}
