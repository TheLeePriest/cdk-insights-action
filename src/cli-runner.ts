import * as exec from '@actions/exec';

export interface AnalysisRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runAnalysis(
  args: string[],
  workingDirectory: string,
  licenseKey: string,
): Promise<AnalysisRunResult> {
  let stdout = '';
  let stderr = '';

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.CI = 'true';

  if (licenseKey) {
    env.CDK_INSIGHTS_LICENSE_KEY = licenseKey;
  }

  const exitCode = await exec.exec('cdk-insights', args, {
    cwd: workingDirectory,
    env,
    ignoreReturnCode: true,
    silent: true,
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString();
      },
      stderr: (data: Buffer) => {
        stderr += data.toString();
      },
    },
  });

  return { exitCode, stdout, stderr };
}
