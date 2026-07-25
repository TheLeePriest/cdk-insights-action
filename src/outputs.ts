import * as core from '@actions/core';
import * as fs from 'node:fs';
import type { FindingClassKey, PillarKey } from './inputs';

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface SeverityCounts {
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

export interface AnalysisResults {
  totalIssues: number;
  /** Counts across every issue in the report - used for user-facing output. */
  totalCounts: SeverityCounts;
  /**
   * Counts restricted to the pillars in `failOnPillars`. Used for exit-code
   * gating so a Reliability warning never blocks a deploy unless the user
   * has explicitly opted in. Equals `totalCounts` when `failOnPillars` is
   * `'all'`.
   */
  gatingCounts: SeverityCounts;
  /**
   * Number of findings per `findingClass` across the whole report (not
   * pillar-scoped). Drives the `fail-on-class` gate, which is orthogonal to
   * severity. Keys are the lower-cased class values the CLI emits
   * (`security` | `best-practice` | `compliance`).
   */
  classCounts: Record<string, number>;
  resourceCount: number;
}

interface Issue {
  severity: Severity;
  resourceId: string;
  issue: string;
  recommendation?: string;
  wafPillar?: string;
  /** Finding class axis (security | best-practice | compliance) - CLI >= 1.43.0. */
  findingClass?: string;
  foundBy?: string;
}

interface RecommendationItem {
  resourceId: string;
  logicalId?: string;
  issues?: Issue[];
}

interface JsonReport {
  summary?: {
    totalIssues?: number;
    severityCounts?: {
      CRITICAL?: number;
      HIGH?: number;
      MEDIUM?: number;
      LOW?: number;
    };
    totalResources?: number;
  };
  recommendations?: RecommendationItem[];
}

const emptyCounts = (): SeverityCounts => ({
  criticalCount: 0,
  highCount: 0,
  mediumCount: 0,
  lowCount: 0,
});

const bumpCount = (counts: SeverityCounts, severity: Severity): void => {
  switch (severity) {
    case 'CRITICAL':
      counts.criticalCount += 1;
      break;
    case 'HIGH':
      counts.highCount += 1;
      break;
    case 'MEDIUM':
      counts.mediumCount += 1;
      break;
    case 'LOW':
      counts.lowCount += 1;
      break;
  }
};

const addCounts = (a: SeverityCounts, b: SeverityCounts): SeverityCounts => ({
  criticalCount: a.criticalCount + b.criticalCount,
  highCount: a.highCount + b.highCount,
  mediumCount: a.mediumCount + b.mediumCount,
  lowCount: a.lowCount + b.lowCount,
});

const matchesFailOnPillar = (
  wafPillar: string | undefined,
  failOnPillars: PillarKey[] | 'all',
): boolean => {
  if (failOnPillars === 'all') return true;
  if (!wafPillar) return false;
  const normalised = wafPillar.toLowerCase().trim() as PillarKey;
  return failOnPillars.includes(normalised);
};

/**
 * Parse a single stack report into total + gating-scoped counts.
 *
 * Pillar-scoped counts require per-issue visibility, so we always
 * re-walk `recommendations[].issues[]` rather than trusting the
 * summary totals. When a report has no recommendations array (older
 * CLI) we fall back to the summary view but gating defaults to match
 * totals - safest over-report. The `summary.totalIssues` value is
 * still used for display in aggregate.
 */
export function parseResults(
  jsonPath: string,
  failOnPillars: PillarKey[] | 'all',
): AnalysisResults {
  const defaults: AnalysisResults = {
    totalIssues: 0,
    totalCounts: emptyCounts(),
    gatingCounts: emptyCounts(),
    classCounts: {},
    resourceCount: 0,
  };

  if (!fs.existsSync(jsonPath)) {
    core.warning(`Results file not found at ${jsonPath}`);
    return defaults;
  }

  try {
    const content = fs.readFileSync(jsonPath, 'utf8');
    const report: JsonReport = JSON.parse(content);

    const totalCounts = emptyCounts();
    const gatingCounts = emptyCounts();
    const classCounts: Record<string, number> = {};
    let totalIssues = 0;
    let resourceCount = 0;

    if (report.recommendations && Array.isArray(report.recommendations)) {
      resourceCount = report.recommendations.length;
      for (const resource of report.recommendations) {
        if (!resource.issues) continue;
        for (const issue of resource.issues) {
          if (!issue.severity) continue;
          totalIssues += 1;
          bumpCount(totalCounts, issue.severity);
          if (matchesFailOnPillar(issue.wafPillar, failOnPillars)) {
            bumpCount(gatingCounts, issue.severity);
          }
          if (issue.findingClass) {
            const cls = issue.findingClass.toLowerCase().trim();
            classCounts[cls] = (classCounts[cls] ?? 0) + 1;
          }
        }
      }
      return {
        totalIssues,
        totalCounts,
        gatingCounts,
        classCounts,
        resourceCount,
      };
    }

    // Fallback: summary-only report (older CLI). Without per-issue
    // pillar data we can't filter safely; treat all as in-scope so
    // gating doesn't under-report.
    if (report.summary) {
      const summaryCounts: SeverityCounts = {
        criticalCount: report.summary.severityCounts?.CRITICAL ?? 0,
        highCount: report.summary.severityCounts?.HIGH ?? 0,
        mediumCount: report.summary.severityCounts?.MEDIUM ?? 0,
        lowCount: report.summary.severityCounts?.LOW ?? 0,
      };
      return {
        totalIssues: report.summary.totalIssues ?? 0,
        totalCounts: summaryCounts,
        gatingCounts: summaryCounts,
        // Summary-only reports carry no per-issue class data, so the
        // class gate can't fire on them (fails open - never blocks).
        classCounts: {},
        resourceCount: report.summary.totalResources ?? 0,
      };
    }

    return defaults;
  } catch (error) {
    core.warning(
      `Failed to parse results file: ${error instanceof Error ? error.message : String(error)}`,
    );
    return defaults;
  }
}

/**
 * Aggregate per-stack reports into a single result set.
 */
export function aggregateResults(
  jsonPaths: string[],
  failOnPillars: PillarKey[] | 'all',
): AnalysisResults {
  const combined: AnalysisResults = {
    totalIssues: 0,
    totalCounts: emptyCounts(),
    gatingCounts: emptyCounts(),
    classCounts: {},
    resourceCount: 0,
  };

  for (const jsonPath of jsonPaths) {
    const result = parseResults(jsonPath, failOnPillars);
    combined.totalIssues += result.totalIssues;
    combined.totalCounts = addCounts(combined.totalCounts, result.totalCounts);
    combined.gatingCounts = addCounts(
      combined.gatingCounts,
      result.gatingCounts,
    );
    for (const [cls, n] of Object.entries(result.classCounts)) {
      combined.classCounts[cls] = (combined.classCounts[cls] ?? 0) + n;
    }
    combined.resourceCount += result.resourceCount;
  }

  return combined;
}

/**
 * Set action outputs and compute the fail-on exit code.
 *
 * Outputs reflect the full view so badges / PR comments never hide
 * findings, but the fail-on exit code is computed strictly from
 * `gatingCounts` - findings whose pillar is in the user's
 * `fail-on-pillars` allowlist (default: security only).
 */
export function setOutputs(
  results: AnalysisResults,
  jsonPaths: string[],
  failOn: string[],
  failOnClass: FindingClassKey[],
  sarifPaths: string[],
  artifactId?: number | null,
): void {
  core.setOutput('total-issues', results.totalIssues.toString());
  core.setOutput(
    'critical-count',
    results.totalCounts.criticalCount.toString(),
  );
  core.setOutput('high-count', results.totalCounts.highCount.toString());
  core.setOutput('medium-count', results.totalCounts.mediumCount.toString());
  core.setOutput('low-count', results.totalCounts.lowCount.toString());
  core.setOutput('json-file', jsonPaths.join(','));

  if (sarifPaths.length > 0) {
    core.setOutput('sarif-file', sarifPaths.join(','));
  }

  if (artifactId != null) {
    core.setOutput('artifact-id', artifactId.toString());
  }

  let exitCode = 0;
  if (failOn.length > 0) {
    const matching =
      (failOn.includes('critical') ? results.gatingCounts.criticalCount : 0) +
      (failOn.includes('high') ? results.gatingCounts.highCount : 0) +
      (failOn.includes('medium') ? results.gatingCounts.mediumCount : 0) +
      (failOn.includes('low') ? results.gatingCounts.lowCount : 0);
    exitCode = matching > 0 ? 1 : 0;
  } else {
    // No fail-on configured: any in-scope finding fails. Respects the
    // pillar filter so a Reliability-only run never blocks by default.
    const totalInScope =
      results.gatingCounts.criticalCount +
      results.gatingCounts.highCount +
      results.gatingCounts.mediumCount +
      results.gatingCounts.lowCount;
    exitCode = totalInScope > 0 ? 1 : 0;
  }

  // Finding-class gate is orthogonal to severity/pillar - fold it into the
  // exit code so a security/compliance finding fails even when severity
  // gating wouldn't (e.g. a MEDIUM security finding under fail-on: critical).
  if (
    exitCode === 0 &&
    failOnClass.some((cls) => (results.classCounts[cls] ?? 0) > 0)
  ) {
    exitCode = 1;
  }

  core.setOutput('exit-code', exitCode.toString());
}
