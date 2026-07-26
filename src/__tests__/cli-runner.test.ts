import * as exec from '@actions/exec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalysis } from '../cli-runner';

vi.mock('@actions/exec');

const mockedExec = vi.mocked(exec);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runAnalysis', () => {
  it('captures machine output without streaming it to the Action log', async () => {
    const streamedOutput: string[] = [];
    const json = '{"schemaVersion":"1.0.0"}\n';
    const diagnostics = 'Scanning stack\n';

    mockedExec.exec.mockImplementation(async (_command, _args, options) => {
      options?.listeners?.stdout?.(Buffer.from(json));
      options?.listeners?.stderr?.(Buffer.from(diagnostics));

      if (!options?.silent) {
        streamedOutput.push(json, diagnostics);
      }

      return 0;
    });

    const result = await runAnalysis([], '/workspace', '');

    expect(result).toEqual({
      exitCode: 0,
      stdout: json,
      stderr: diagnostics,
    });
    expect(streamedOutput).toEqual([]);
  });
});
