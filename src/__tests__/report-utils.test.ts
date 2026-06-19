import { describe, it, expect } from 'vitest';
import {
  CONSOLIDATED_SARIF,
  selectSarifFiles,
  versionGte,
} from '../report-utils';

describe('versionGte', () => {
  it('compares major.minor.patch numerically', () => {
    expect(versionGte('1.44.0', '1.44.0')).toBe(true);
    expect(versionGte('1.44.1', '1.44.0')).toBe(true);
    expect(versionGte('1.45.0', '1.44.0')).toBe(true);
    expect(versionGte('2.0.0', '1.44.0')).toBe(true);
    expect(versionGte('1.43.9', '1.44.0')).toBe(false);
    expect(versionGte('1.43.0', '1.44.0')).toBe(false);
    expect(versionGte('0.99.0', '1.44.0')).toBe(false);
  });

  it('ignores pre-release suffixes (compares on the numeric core)', () => {
    expect(versionGte('1.44.0-beta.1', '1.44.0')).toBe(true);
    expect(versionGte('1.44.0', '1.44.0-anything')).toBe(true);
  });

  it('tolerates a leading v', () => {
    expect(versionGte('v1.44.0', '1.44.0')).toBe(true);
  });
});

describe('selectSarifFiles', () => {
  it('returns only the consolidated file when present (multi-stack)', () => {
    const files = [
      `/work/StackA${'_analysis_report'}.sarif`,
      `/work/StackB_analysis_report.sarif`,
      `/work/${CONSOLIDATED_SARIF}`,
    ];
    expect(selectSarifFiles(files)).toEqual([`/work/${CONSOLIDATED_SARIF}`]);
  });

  it('returns the per-stack file(s) when there is no consolidated file (single stack)', () => {
    const files = ['/work/StackA_analysis_report.sarif'];
    expect(selectSarifFiles(files)).toEqual(files);
  });

  it('returns an empty list unchanged', () => {
    expect(selectSarifFiles([])).toEqual([]);
  });
});
