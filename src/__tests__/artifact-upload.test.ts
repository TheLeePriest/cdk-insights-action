import * as core from '@actions/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadReportArtifacts } from '../artifact-upload';

vi.mock('@actions/core');

const mockUploadArtifact = vi.fn();
vi.mock('@actions/artifact', () => ({
  DefaultArtifactClient: class {
    uploadArtifact = mockUploadArtifact;
  },
}));

const mockedCore = vi.mocked(core);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('uploadReportArtifacts', () => {
  it('uploads files and returns artifact ID', async () => {
    mockUploadArtifact.mockResolvedValue({ id: 42, size: 5120 });

    const result = await uploadReportArtifacts(
      ['/workspace/report.json', '/workspace/report.sarif'],
      'cdk-insights-report',
      '/workspace',
    );

    expect(result).toBe(42);
    expect(mockUploadArtifact).toHaveBeenCalledWith(
      'cdk-insights-report',
      ['/workspace/report.json', '/workspace/report.sarif'],
      expect.any(String),
      { retentionDays: 90 },
    );
    expect(mockedCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Artifact "cdk-insights-report" uploaded'),
    );
  });

  it('returns null for empty file list', async () => {
    const result = await uploadReportArtifacts(
      [],
      'cdk-insights-report',
      '/workspace',
    );

    expect(result).toBeNull();
    expect(mockUploadArtifact).not.toHaveBeenCalled();
  });

  it('warns on failure and returns null without throwing', async () => {
    mockUploadArtifact.mockRejectedValue(new Error('Upload failed'));

    const result = await uploadReportArtifacts(
      ['/workspace/report.json'],
      'cdk-insights-report',
      '/workspace',
    );

    expect(result).toBeNull();
    expect(mockedCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to upload artifact'),
    );
  });

  it('returns null when upload returns no ID', async () => {
    mockUploadArtifact.mockResolvedValue({ id: undefined, size: undefined });

    const result = await uploadReportArtifacts(
      ['/workspace/report.json'],
      'cdk-insights-report',
      '/workspace',
    );

    expect(result).toBeNull();
    expect(mockedCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('no artifact ID'),
    );
  });
});
