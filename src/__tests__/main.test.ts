import { describe, it, expect } from 'vitest';
import { buildScanArgs, buildSarifArgs } from '../args';
import { ActionInputs } from '../inputs';

function defaultInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    licenseKey: '',
    workingDirectory: '.',
    stackName: '',
    aiAnalysis: false,
    failOn: [],
    failOnPillars: ['security'],
    prComment: true,
    sarifUpload: false,
    uploadArtifact: true,
    artifactName: 'cdk-insights-report',
    githubToken: '',
    services: [],
    ruleFilter: [],
    cdkInsightsVersion: 'latest',
    ...overrides,
  };
}

describe('buildScanArgs', () => {
  it('builds default args with --all when no stack name', () => {
    const args = buildScanArgs(defaultInputs());

    expect(args).toContain('scan');
    expect(args).toContain('--all');
    expect(args).toContain('--yes');
    expect(args).toContain('--no-failOnCritical');
    expect(args).toContain('--warn-sensitive');
    expect(args).toContain('--prComment');
    expect(args.slice(-2)).toEqual(['--format', 'json']);
  });

  it('uses -- separator and stack name instead of --all when provided', () => {
    const args = buildScanArgs(defaultInputs({ stackName: 'MyStack' }));

    expect(args).toContain('MyStack');
    expect(args).toContain('--');
    const ddIdx = args.indexOf('--');
    expect(args[ddIdx + 1]).toBe('MyStack');
    expect(args).not.toContain('--all');
  });

  it('does not include --prComment when disabled', () => {
    const args = buildScanArgs(defaultInputs({ prComment: false }));

    expect(args).not.toContain('--prComment');
  });

  it('passes --local when license key provided but ai-analysis is false', () => {
    const args = buildScanArgs(defaultInputs({
      licenseKey: 'key-123',
      aiAnalysis: false,
    }));

    expect(args).toContain('--local');
  });

  it('does not pass --local when ai-analysis is true with license key', () => {
    const args = buildScanArgs(defaultInputs({
      licenseKey: 'key-123',
      aiAnalysis: true,
    }));

    expect(args).not.toContain('--local');
  });

  it('does not pass --local when no license key regardless of ai-analysis', () => {
    const args = buildScanArgs(defaultInputs({
      licenseKey: '',
      aiAnalysis: true,
    }));

    expect(args).not.toContain('--local');
  });

  it('passes services as individual args', () => {
    const args = buildScanArgs(defaultInputs({
      services: ['S3', 'Lambda', 'IAM'],
    }));

    const servicesIdx = args.indexOf('--services');
    expect(servicesIdx).toBeGreaterThan(-1);
    expect(args[servicesIdx + 1]).toBe('S3');
    expect(args[servicesIdx + 2]).toBe('Lambda');
    expect(args[servicesIdx + 3]).toBe('IAM');
  });

  it('passes ruleFilter as individual args', () => {
    const args = buildScanArgs(defaultInputs({
      ruleFilter: ['RULE-001', 'RULE-002'],
    }));

    const filterIdx = args.indexOf('--ruleFilter');
    expect(filterIdx).toBeGreaterThan(-1);
    expect(args[filterIdx + 1]).toBe('RULE-001');
    expect(args[filterIdx + 2]).toBe('RULE-002');
  });

  it('omits --services when empty', () => {
    const args = buildScanArgs(defaultInputs({ services: [] }));

    expect(args).not.toContain('--services');
  });

  it('omits --ruleFilter when empty', () => {
    const args = buildScanArgs(defaultInputs({ ruleFilter: [] }));

    expect(args).not.toContain('--ruleFilter');
  });

  it('never includes --ai flag', () => {
    const args = buildScanArgs(defaultInputs({
      aiAnalysis: true,
      licenseKey: 'key-123',
    }));

    expect(args).not.toContain('--ai');
  });

  it('never includes --outputFile flag', () => {
    const args = buildScanArgs(defaultInputs());

    expect(args).not.toContain('--outputFile');
  });
});

describe('buildSarifArgs', () => {
  it('builds sarif args with correct format', () => {
    const args = buildSarifArgs(defaultInputs());

    expect(args).toContain('scan');
    expect(args).toContain('--all');
    expect(args).toContain('--yes');
    expect(args).toContain('--no-failOnCritical');
    expect(args).toContain('--warn-sensitive');
    expect(args.slice(-2)).toEqual(['--format', 'sarif']);
  });

  it('uses -- separator and stack name when provided', () => {
    const args = buildSarifArgs(defaultInputs({ stackName: 'ProdStack' }));

    expect(args).toContain('ProdStack');
    expect(args).toContain('--');
    const ddIdx = args.indexOf('--');
    expect(args[ddIdx + 1]).toBe('ProdStack');
    expect(args).not.toContain('--all');
  });

  it('does not include prComment or services in sarif args', () => {
    const args = buildSarifArgs(defaultInputs({
      prComment: true,
      services: ['S3'],
    }));

    expect(args).not.toContain('--prComment');
    expect(args).not.toContain('--services');
  });
});
