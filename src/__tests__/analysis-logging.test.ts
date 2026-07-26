import * as core from '@actions/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logAnalysisOutput } from '../analysis-logging';

vi.mock('@actions/core');

const mockedCore = vi.mocked(core);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('logAnalysisOutput', () => {
  it('logs diagnostics and JSON size without logging the machine document', () => {
    const json = '{"schemaVersion":"1.0.0"}\n';

    logAnalysisOutput(json, 'Scanning stack\n');

    expect(mockedCore.debug).toHaveBeenCalledWith(
      `Captured CLI JSON output (${Buffer.byteLength(json)} bytes)`,
    );
    expect(mockedCore.info).toHaveBeenCalledWith('Scanning stack\n');

    const emitted = [
      ...mockedCore.debug.mock.calls,
      ...mockedCore.info.mock.calls,
    ].flat();
    expect(emitted.join('\n')).not.toContain('schemaVersion');
  });
});
