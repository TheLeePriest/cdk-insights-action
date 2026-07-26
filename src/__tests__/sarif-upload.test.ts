import * as fs from 'node:fs';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadSarifToCodeScanning } from '../sarif-upload';

vi.mock('@actions/core');
vi.mock('@actions/github');
vi.mock('node:fs');

const mockedCore = vi.mocked(core);
const mockedGithub = vi.mocked(github);
const mockedFs = vi.mocked(fs);

const mockUploadSarif = vi.fn();
const mockGetOctokit = vi.fn().mockReturnValue({
  rest: {
    codeScanning: {
      uploadSarif: mockUploadSarif,
    },
  },
});
const mutableGithub = mockedGithub as unknown as {
  getOctokit: typeof mockGetOctokit;
  context: {
    repo: { owner: string; repo: string };
    sha: string;
    ref: string;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_WORKSPACE = '/workspace/repository';

  mutableGithub.getOctokit = mockGetOctokit;
  mutableGithub.context = {
    repo: { owner: 'test-owner', repo: 'test-repo' },
    sha: 'abc123',
    ref: 'refs/heads/main',
  };
});

describe('uploadSarifToCodeScanning', () => {
  it('uploads a single SARIF file with gzip + base64 encoding', async () => {
    const sarifContent = '{"version":"2.1.0","runs":[]}';
    mockedFs.readFileSync.mockReturnValue(sarifContent);
    mockUploadSarif.mockResolvedValue({ data: { id: 'sarif-123' } });

    await uploadSarifToCodeScanning(['/path/to/results.sarif'], 'test-token');

    expect(mockGetOctokit).toHaveBeenCalledWith('test-token');
    expect(mockUploadSarif).toHaveBeenCalledTimes(1);
    expect(mockUploadSarif).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      commit_sha: 'abc123',
      ref: 'refs/heads/main',
      checkout_uri: 'file:///workspace/repository/',
      sarif: expect.any(String),
    });

    // Verify the sarif field is base64-encoded gzipped content (not raw JSON)
    const sarifArg = mockUploadSarif.mock.calls[0][0].sarif;
    expect(sarifArg).not.toBe(sarifContent);
    expect(typeof sarifArg).toBe('string');

    expect(mockedCore.info).toHaveBeenCalledWith(
      expect.stringContaining('SARIF uploaded'),
    );
  });

  it('uploads multiple SARIF files', async () => {
    mockedFs.readFileSync.mockReturnValue('{"version":"2.1.0","runs":[]}');
    mockUploadSarif.mockResolvedValue({ data: { id: 'sarif-1' } });

    await uploadSarifToCodeScanning(
      ['/path/to/stack1.sarif', '/path/to/stack2.sarif'],
      'test-token',
    );

    expect(mockUploadSarif).toHaveBeenCalledTimes(2);
  });

  it('warns on upload failure without throwing', async () => {
    mockedFs.readFileSync.mockReturnValue('{"version":"2.1.0","runs":[]}');
    mockUploadSarif.mockRejectedValue(new Error('403 Forbidden'));

    await expect(
      uploadSarifToCodeScanning(['/path/to/results.sarif'], 'test-token'),
    ).resolves.toBeUndefined();

    expect(mockedCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to upload SARIF'),
    );
  });

  it('continues uploading remaining files after one fails', async () => {
    mockedFs.readFileSync.mockReturnValue('{"version":"2.1.0","runs":[]}');
    mockUploadSarif
      .mockRejectedValueOnce(new Error('403 Forbidden'))
      .mockResolvedValueOnce({ data: { id: 'sarif-2' } });

    await uploadSarifToCodeScanning(
      ['/path/to/stack1.sarif', '/path/to/stack2.sarif'],
      'test-token',
    );

    expect(mockUploadSarif).toHaveBeenCalledTimes(2);
    expect(mockedCore.warning).toHaveBeenCalledTimes(1);
    expect(mockedCore.info).toHaveBeenCalledWith(
      expect.stringContaining('SARIF uploaded'),
    );
  });
});
