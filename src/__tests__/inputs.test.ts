import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as core from '@actions/core';
import { parseInputs } from '../inputs';

vi.mock('@actions/core');

const mockedCore = vi.mocked(core);

function mockInputs(overrides: Record<string, string> = {}): void {
  const defaults: Record<string, string> = {
    'license-key': '',
    'working-directory': '.',
    'stack-name': '',
    'ai-analysis': 'false',
    'pr-comment': 'true',
    'sarif-upload': 'false',
    'upload-artifact': 'true',
    'artifact-name': 'cdk-insights-report',
    'github-token': '',
    services: '',
    'rule-filter': '',
    'fail-on': '',
    'fail-on-class': '',
    'cdk-insights-version': 'latest',
  };

  const values = { ...defaults, ...overrides };

  mockedCore.getInput.mockImplementation((name: string) => values[name] || '');
  mockedCore.getBooleanInput.mockImplementation(
    (name: string) => values[name] === 'true',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseInputs', () => {
  it('returns defaults when no inputs provided', () => {
    mockInputs();

    const result = parseInputs();

    expect(result.licenseKey).toBe('');
    expect(result.workingDirectory).toBe('.');
    expect(result.stackName).toBe('');
    expect(result.aiAnalysis).toBe(false);
    expect(result.prComment).toBe(true);
    expect(result.sarifUpload).toBe(false);
    expect(result.failOn).toEqual([]);
    expect(result.failOnClass).toEqual([]);
    expect(result.services).toEqual([]);
    expect(result.ruleFilter).toEqual([]);
    expect(result.cdkInsightsVersion).toBe('latest');
  });

  it('parses and lowercases comma-separated fail-on-class values', () => {
    mockInputs({ 'fail-on-class': 'Security, Compliance' });

    const result = parseInputs();

    expect(result.failOnClass).toEqual(['security', 'compliance']);
  });

  it('drops unknown fail-on-class values with a warning', () => {
    mockInputs({ 'fail-on-class': 'security,bogus' });

    const result = parseInputs();

    expect(result.failOnClass).toEqual(['security']);
    expect(mockedCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Unknown fail-on-class value "bogus"'),
    );
  });

  it('parses comma-separated fail-on values', () => {
    mockInputs({ 'fail-on': 'critical, high , medium' });

    const result = parseInputs();

    expect(result.failOn).toEqual(['critical', 'high', 'medium']);
  });

  it('lowercases fail-on values', () => {
    mockInputs({ 'fail-on': 'CRITICAL,High' });

    const result = parseInputs();

    expect(result.failOn).toEqual(['critical', 'high']);
  });

  it('warns on invalid severity values', () => {
    mockInputs({ 'fail-on': 'critical,invalid' });

    parseInputs();

    expect(mockedCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Invalid severity in fail-on: invalid'),
    );
  });

  it('parses comma-separated services', () => {
    mockInputs({ services: 'S3, Lambda, DynamoDB' });

    const result = parseInputs();

    expect(result.services).toEqual(['S3', 'Lambda', 'DynamoDB']);
  });

  it('parses comma-separated rule filter', () => {
    mockInputs({ 'rule-filter': 'RULE-001, RULE-002' });

    const result = parseInputs();

    expect(result.ruleFilter).toEqual(['RULE-001', 'RULE-002']);
  });

  it('masks license key as secret when provided', () => {
    mockInputs({ 'license-key': 'my-secret-key' });

    parseInputs();

    expect(mockedCore.setSecret).toHaveBeenCalledWith('my-secret-key');
  });

  it('does not call setSecret when no license key', () => {
    mockInputs({ 'license-key': '' });

    parseInputs();

    // github-token is also empty, so no setSecret calls
    expect(mockedCore.setSecret).not.toHaveBeenCalled();
  });

  it('parses upload-artifact input', () => {
    mockInputs({ 'upload-artifact': 'true' });

    const result = parseInputs();

    expect(result.uploadArtifact).toBe(true);
  });

  it('parses artifact-name input', () => {
    mockInputs({ 'artifact-name': 'my-reports' });

    const result = parseInputs();

    expect(result.artifactName).toBe('my-reports');
  });

  it('defaults artifact-name to cdk-insights-report', () => {
    mockInputs({ 'artifact-name': '' });

    const result = parseInputs();

    expect(result.artifactName).toBe('cdk-insights-report');
  });

  it('masks github-token as secret when provided', () => {
    mockInputs({ 'github-token': 'ghp_test123' });

    parseInputs();

    expect(mockedCore.setSecret).toHaveBeenCalledWith('ghp_test123');
  });

  it('uses custom working directory', () => {
    mockInputs({ 'working-directory': 'packages/api' });

    const result = parseInputs();

    expect(result.workingDirectory).toBe('packages/api');
  });

  it('defaults cdk-insights-version to latest when empty', () => {
    mockInputs({ 'cdk-insights-version': '' });

    const result = parseInputs();

    expect(result.cdkInsightsVersion).toBe('latest');
  });

  // --- Input validation tests ---

  it('rejects stack name with flag-like value', () => {
    mockInputs({ 'stack-name': '--malicious' });

    expect(() => parseInputs()).toThrow('must not start with a hyphen');
  });

  it('rejects stack name with spaces', () => {
    mockInputs({ 'stack-name': 'My Stack' });

    expect(() => parseInputs()).toThrow('Invalid stack-name');
  });

  it('accepts valid stack names', () => {
    mockInputs({ 'stack-name': 'My-Stack_123' });

    const result = parseInputs();
    expect(result.stackName).toBe('My-Stack_123');
  });

  it('rejects service with flag-like value', () => {
    mockInputs({ services: 'S3,--inject' });

    expect(() => parseInputs()).toThrow('must not start with a hyphen');
  });

  it('rejects rule-filter with shell metacharacters', () => {
    mockInputs({ 'rule-filter': 'RULE-001,$(whoami)' });

    expect(() => parseInputs()).toThrow('Invalid rule-filter');
  });

  it('accepts valid rule-filter values', () => {
    mockInputs({ 'rule-filter': 'RULE-001,SEC.002' });

    const result = parseInputs();
    expect(result.ruleFilter).toEqual(['RULE-001', 'SEC.002']);
  });

  it('rejects invalid version string', () => {
    mockInputs({ 'cdk-insights-version': '1.0.0; rm -rf /' });

    expect(() => parseInputs()).toThrow('Invalid cdk-insights-version');
  });

  it('accepts semver version string', () => {
    mockInputs({ 'cdk-insights-version': '2.1.0' });

    const result = parseInputs();
    expect(result.cdkInsightsVersion).toBe('2.1.0');
  });

  it('accepts semver with prerelease tag', () => {
    mockInputs({ 'cdk-insights-version': '2.1.0-beta.1' });

    const result = parseInputs();
    expect(result.cdkInsightsVersion).toBe('2.1.0-beta.1');
  });

  it('rejects working directory with path traversal', () => {
    mockInputs({ 'working-directory': '../../etc' });

    expect(() => parseInputs()).toThrow('resolves outside the workspace');
  });

  it('filters empty strings from services list', () => {
    mockInputs({ services: 'S3,,Lambda,' });

    const result = parseInputs();
    expect(result.services).toEqual(['S3', 'Lambda']);
  });
});
