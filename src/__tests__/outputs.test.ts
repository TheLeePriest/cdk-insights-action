import * as fs from 'node:fs';
import * as core from '@actions/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AnalysisResults,
  aggregateResults,
  parseResults,
  type SeverityCounts,
  setOutputs,
} from '../outputs';

vi.mock('@actions/core');
vi.mock('node:fs');

const mockedFs = vi.mocked(fs);
const mockedCore = vi.mocked(core);

beforeEach(() => {
  vi.clearAllMocks();
});

const zeroCounts: SeverityCounts = {
  criticalCount: 0,
  highCount: 0,
  mediumCount: 0,
  lowCount: 0,
};

const counts = (
  critical: number,
  high: number,
  medium: number,
  low: number,
): SeverityCounts => ({
  criticalCount: critical,
  highCount: high,
  mediumCount: medium,
  lowCount: low,
});

describe('parseResults', () => {
  it('returns defaults when file does not exist', () => {
    mockedFs.existsSync.mockReturnValue(false);

    const result = parseResults('/missing.json', 'all');

    expect(result).toEqual({
      totalIssues: 0,
      totalCounts: zeroCounts,
      gatingCounts: zeroCounts,
      classCounts: {},
      resourceCount: 0,
    });
    expect(mockedCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
    );
  });

  it('falls back to summary-based JSON when recommendations are absent', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        summary: {
          totalIssues: 10,
          severityCounts: { CRITICAL: 1, HIGH: 3, MEDIUM: 4, LOW: 2 },
          totalResources: 20,
        },
      }),
    );

    const result = parseResults('/results.json', 'all');

    // Summary-only reports can't be pillar-filtered safely, so totals
    // and gating match.
    expect(result).toEqual({
      totalIssues: 10,
      totalCounts: counts(1, 3, 4, 2),
      gatingCounts: counts(1, 3, 4, 2),
      classCounts: {},
      resourceCount: 20,
    });
  });

  it('walks recommendations and counts by severity', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        recommendations: [
          {
            resourceId: 'Bucket',
            issues: [
              {
                severity: 'CRITICAL',
                resourceId: 'Bucket',
                issue: 'No encryption',
                wafPillar: 'Security',
              },
              {
                severity: 'HIGH',
                resourceId: 'Bucket',
                issue: 'Public access',
                wafPillar: 'Security',
              },
            ],
          },
          {
            resourceId: 'Lambda',
            issues: [
              {
                severity: 'LOW',
                resourceId: 'Lambda',
                issue: 'No DLQ',
                wafPillar: 'Reliability',
              },
            ],
          },
        ],
      }),
    );

    const result = parseResults('/results.json', 'all');

    expect(result).toEqual({
      totalIssues: 3,
      totalCounts: counts(1, 1, 0, 1),
      gatingCounts: counts(1, 1, 0, 1),
      classCounts: {},
      resourceCount: 2,
    });
  });

  it('counts findings by findingClass across all pillars', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        recommendations: [
          {
            resourceId: 'Bucket',
            issues: [
              {
                severity: 'CRITICAL',
                resourceId: 'Bucket',
                issue: 'a',
                wafPillar: 'Security',
                findingClass: 'security',
              },
              {
                severity: 'MEDIUM',
                resourceId: 'Bucket',
                issue: 'b',
                wafPillar: 'Operational Excellence',
                findingClass: 'best-practice',
              },
              {
                severity: 'HIGH',
                resourceId: 'Bucket',
                issue: 'c',
                wafPillar: 'Security',
                findingClass: 'Security',
              },
            ],
          },
        ],
      }),
    );

    const result = parseResults('/results.json', ['security']);

    // Class counts are case-normalised and pillar-independent.
    expect(result.classCounts).toEqual({ security: 2, 'best-practice': 1 });
  });

  it('scopes gating counts to fail-on-pillars (security-only by default)', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        recommendations: [
          {
            resourceId: 'Bucket',
            issues: [
              {
                severity: 'CRITICAL',
                resourceId: 'Bucket',
                issue: 'Secret',
                wafPillar: 'Security',
              },
              {
                severity: 'HIGH',
                resourceId: 'Bucket',
                issue: 'DLQ shared',
                wafPillar: 'Reliability',
              },
              {
                severity: 'HIGH',
                resourceId: 'Bucket',
                issue: 'Over-provisioned',
                wafPillar: 'Cost Optimization',
              },
            ],
          },
        ],
      }),
    );

    const result = parseResults('/results.json', ['security']);

    expect(result.totalIssues).toBe(3);
    expect(result.totalCounts).toEqual(counts(1, 2, 0, 0));
    // Reliability + Cost filtered out of gating counts
    expect(result.gatingCounts).toEqual(counts(1, 0, 0, 0));
  });

  it('includes every pillar when fail-on-pillars is "all"', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        recommendations: [
          {
            resourceId: 'X',
            issues: [
              {
                severity: 'HIGH',
                resourceId: 'X',
                issue: 'a',
                wafPillar: 'Reliability',
              },
              {
                severity: 'MEDIUM',
                resourceId: 'X',
                issue: 'b',
                wafPillar: 'Cost Optimization',
              },
            ],
          },
        ],
      }),
    );

    const result = parseResults('/results.json', 'all');
    expect(result.gatingCounts).toEqual(counts(0, 1, 1, 0));
  });

  it('returns defaults for invalid JSON', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('not json');

    const result = parseResults('/bad.json', 'all');

    expect(result).toEqual({
      totalIssues: 0,
      totalCounts: zeroCounts,
      gatingCounts: zeroCounts,
      classCounts: {},
      resourceCount: 0,
    });
    expect(mockedCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse'),
    );
  });

  it('returns defaults for empty report', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({}));

    const result = parseResults('/empty.json', 'all');

    expect(result).toEqual({
      totalIssues: 0,
      totalCounts: zeroCounts,
      gatingCounts: zeroCounts,
      classCounts: {},
      resourceCount: 0,
    });
  });
});

describe('aggregateResults', () => {
  it('returns zeros for empty file list', () => {
    const result = aggregateResults([], 'all');

    expect(result).toEqual({
      totalIssues: 0,
      totalCounts: zeroCounts,
      gatingCounts: zeroCounts,
      classCounts: {},
      resourceCount: 0,
    });
  });

  it('aggregates results from multiple files', () => {
    mockedFs.existsSync.mockReturnValue(true);

    // First file (summary-only)
    mockedFs.readFileSync.mockReturnValueOnce(
      JSON.stringify({
        summary: {
          totalIssues: 5,
          severityCounts: { CRITICAL: 1, HIGH: 2, MEDIUM: 1, LOW: 1 },
          totalResources: 10,
        },
      }),
    );

    // Second file (summary-only)
    mockedFs.readFileSync.mockReturnValueOnce(
      JSON.stringify({
        summary: {
          totalIssues: 3,
          severityCounts: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 0 },
          totalResources: 5,
        },
      }),
    );

    const result = aggregateResults(['/stack1.json', '/stack2.json'], 'all');

    expect(result.totalIssues).toBe(8);
    expect(result.totalCounts).toEqual(counts(1, 3, 3, 1));
    expect(result.gatingCounts).toEqual(counts(1, 3, 3, 1));
    expect(result.resourceCount).toBe(15);
  });
});

describe('setOutputs', () => {
  const baseResults: AnalysisResults = {
    totalIssues: 10,
    totalCounts: counts(1, 3, 4, 2),
    gatingCounts: counts(1, 3, 4, 2),
    classCounts: {},
    resourceCount: 20,
  };

  it('sets all outputs correctly', () => {
    setOutputs(baseResults, ['/results.json'], [], [], [], null);

    expect(mockedCore.setOutput).toHaveBeenCalledWith('total-issues', '10');
    expect(mockedCore.setOutput).toHaveBeenCalledWith('critical-count', '1');
    expect(mockedCore.setOutput).toHaveBeenCalledWith('high-count', '3');
    expect(mockedCore.setOutput).toHaveBeenCalledWith('medium-count', '4');
    expect(mockedCore.setOutput).toHaveBeenCalledWith('low-count', '2');
    expect(mockedCore.setOutput).toHaveBeenCalledWith(
      'json-file',
      '/results.json',
    );
  });

  it('joins multiple json file paths', () => {
    setOutputs(baseResults, ['/stack1.json', '/stack2.json'], [], [], [], null);

    expect(mockedCore.setOutput).toHaveBeenCalledWith(
      'json-file',
      '/stack1.json,/stack2.json',
    );
  });

  it('sets sarif-file output when paths provided', () => {
    setOutputs(
      baseResults,
      ['/results.json'],
      [],
      [],
      ['/results.sarif'],
      null,
    );

    expect(mockedCore.setOutput).toHaveBeenCalledWith(
      'sarif-file',
      '/results.sarif',
    );
  });

  it('does not set sarif-file when no paths', () => {
    setOutputs(baseResults, ['/results.json'], [], [], [], null);

    const sarifCall = (
      mockedCore.setOutput as ReturnType<typeof vi.fn>
    ).mock.calls.find((c: unknown[]) => c[0] === 'sarif-file');
    expect(sarifCall).toBeUndefined();
  });

  it('sets exit-code 1 when gating issues exist and no fail-on', () => {
    setOutputs(baseResults, ['/results.json'], [], [], [], null);

    expect(mockedCore.setOutput).toHaveBeenCalledWith('exit-code', '1');
  });

  it('sets exit-code 0 when no gating issues', () => {
    const noGating: AnalysisResults = {
      totalIssues: 3,
      totalCounts: counts(0, 3, 0, 0),
      gatingCounts: zeroCounts,
      classCounts: {},
      resourceCount: 5,
    };
    setOutputs(noGating, ['/results.json'], [], [], [], null);

    expect(mockedCore.setOutput).toHaveBeenCalledWith('exit-code', '0');
  });

  it('respects fail-on: exit-code 0 when gating issues exist but not at configured severity', () => {
    const lowGatingOnly: AnalysisResults = {
      totalIssues: 3,
      totalCounts: counts(0, 0, 0, 3),
      gatingCounts: counts(0, 0, 0, 3),
      classCounts: {},
      resourceCount: 2,
    };
    setOutputs(
      lowGatingOnly,
      ['/results.json'],
      ['critical', 'high'],
      [],
      [],
      null,
    );

    expect(mockedCore.setOutput).toHaveBeenCalledWith('exit-code', '0');
  });

  it('respects fail-on: exit-code 1 when gating issues at configured severity', () => {
    const withCritical: AnalysisResults = {
      totalIssues: 5,
      totalCounts: counts(2, 0, 0, 3),
      gatingCounts: counts(2, 0, 0, 3),
      classCounts: {},
      resourceCount: 3,
    };
    setOutputs(withCritical, ['/results.json'], ['critical'], [], [], null);

    expect(mockedCore.setOutput).toHaveBeenCalledWith('exit-code', '1');
  });

  it('does not fail when a Reliability CRITICAL is filtered out of gating', () => {
    const reliabilityCriticalOnly: AnalysisResults = {
      totalIssues: 1,
      totalCounts: counts(1, 0, 0, 0),
      gatingCounts: zeroCounts,
      classCounts: {},
      resourceCount: 1,
    };
    setOutputs(
      reliabilityCriticalOnly,
      ['/results.json'],
      ['critical'],
      [],
      [],
      null,
    );

    expect(mockedCore.setOutput).toHaveBeenCalledWith('exit-code', '0');
  });

  it('fail-on-class: exit-code 1 when a matching class exists, even with no severity gate hit', () => {
    // A MEDIUM security finding: severity gate (fail-on: critical) wouldn't
    // fire, but fail-on-class: security must.
    const mediumSecurity: AnalysisResults = {
      totalIssues: 1,
      totalCounts: counts(0, 0, 1, 0),
      gatingCounts: zeroCounts,
      classCounts: { security: 1 },
      resourceCount: 1,
    };
    setOutputs(
      mediumSecurity,
      ['/results.json'],
      ['critical'],
      ['security'],
      [],
      null,
    );

    expect(mockedCore.setOutput).toHaveBeenCalledWith('exit-code', '1');
  });

  it('fail-on-class: exit-code 0 when no finding matches the configured class', () => {
    const bestPracticeOnly: AnalysisResults = {
      totalIssues: 1,
      totalCounts: counts(0, 0, 1, 0),
      gatingCounts: zeroCounts,
      classCounts: { 'best-practice': 1 },
      resourceCount: 1,
    };
    setOutputs(
      bestPracticeOnly,
      ['/results.json'],
      ['critical'],
      ['security'],
      [],
      null,
    );

    expect(mockedCore.setOutput).toHaveBeenCalledWith('exit-code', '0');
  });

  it('sets artifact-id output when provided', () => {
    setOutputs(baseResults, ['/results.json'], [], [], [], 42);

    expect(mockedCore.setOutput).toHaveBeenCalledWith('artifact-id', '42');
  });

  it('does not set artifact-id when null', () => {
    setOutputs(baseResults, ['/results.json'], [], [], [], null);

    const artifactCall = (
      mockedCore.setOutput as ReturnType<typeof vi.fn>
    ).mock.calls.find((c: unknown[]) => c[0] === 'artifact-id');
    expect(artifactCall).toBeUndefined();
  });
});
