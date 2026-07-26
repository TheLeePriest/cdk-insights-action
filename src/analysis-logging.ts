import * as core from '@actions/core';

export function logAnalysisOutput(stdout: string, stderr: string): void {
  if (stdout) {
    core.debug(`Captured CLI JSON output (${Buffer.byteLength(stdout)} bytes)`);
  }

  if (stderr) {
    core.info(stderr);
  }
}
