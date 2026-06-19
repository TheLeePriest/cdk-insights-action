import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as tc from '@actions/tool-cache';
import * as fs from 'fs';
import * as path from 'path';
import { parseInputs } from './inputs';
import { aggregateResults, setOutputs } from './outputs';
import { buildScanArgs, buildSarifArgs, ExtraReportFormat } from './args';
import { uploadSarifToCodeScanning } from './sarif-upload';
import { uploadReportArtifacts } from './artifact-upload';
import {
  REPORT_SUFFIX,
  REPORTS_FLAG_MIN_VERSION,
  selectSarifFiles,
  versionGte,
} from './report-utils';

const TOOL_NAME = 'cdk-insights';

/**
 * Resolve the version string to install.
 * If 'latest', queries npm for the actual version number (needed for cache key).
 */
async function resolveVersion(version: string): Promise<string> {
  if (version !== 'latest') return version;

  let stdout = '';
  await exec.exec(
    'npm',
    [
      'view',
      'cdk-insights',
      'version',
      '--registry',
      'https://registry.npmjs.org',
    ],
    {
      silent: true,
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString();
        },
      },
    },
  );

  return stdout.trim();
}

/**
 * Install cdk-insights CLI with tool caching.
 * On first run: installs via npm and caches. On subsequent runs: restores from cache.
 * Returns the resolved (numeric) version so the caller can gate features.
 */
async function installCdkInsights(requestedVersion: string): Promise<string> {
  const version = await resolveVersion(requestedVersion);
  core.info(`Resolved cdk-insights version: ${version}`);

  // Check tool cache first
  const cachedPath = tc.find(TOOL_NAME, version);
  if (cachedPath) {
    core.info(`Using cached cdk-insights ${version}`);
    core.addPath(path.join(cachedPath, 'bin'));
    return version;
  }

  // Not cached — install to a temp directory and cache it
  core.info(`Installing cdk-insights@${version}...`);
  const installDir = path.join(
    process.env.RUNNER_TEMP || '/tmp',
    `cdk-insights-${version}`,
  );
  fs.mkdirSync(installDir, { recursive: true });

  await exec.exec(
    'npm',
    [
      'install',
      '--prefix',
      installDir,
      '--registry',
      'https://registry.npmjs.org',
      `cdk-insights@${version}`,
    ],
    {
      silent: false,
    },
  );

  // The binary is at installDir/node_modules/.bin/cdk-insights
  const binDir = path.join(installDir, 'node_modules', '.bin');
  const cdkInsightsPath = path.join(binDir, 'cdk-insights');
  if (!fs.existsSync(cdkInsightsPath)) {
    throw new Error(
      'cdk-insights installation failed - binary not found after npm install',
    );
  }

  // Cache the install directory for future runs
  const cached = await tc.cacheDir(installDir, TOOL_NAME, version);
  core.addPath(path.join(cached, 'node_modules', '.bin'));

  core.info(`cdk-insights ${version} installed and cached`);
  return version;
}

async function runAnalysis(
  args: string[],
  workingDirectory: string,
  licenseKey: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';

  // Forward the full workflow environment to the CLI subprocess.
  //
  // Earlier revisions of this action maintained an ENV_ALLOWLIST of
  // variables to forward (PATH, HOME, GITHUB_*, etc.). The intent was
  // defence-in-depth: stop accidental leakage of workflow secrets into
  // the CLI. In practice the allowlist blocked every env var a CDK
  // app reads at synth time — AWS_REGION / AWS_ACCESS_KEY_ID /
  // AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN for SDK calls,
  // CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION for bootstrap targeting,
  // and project-specific config vars like STAGE, STRIPE_EVENT_SOURCE_NAME,
  // TARGET_EVENT_BUS_NAME. That broke every non-trivial CDK app: the
  // CLI would run `cdk synth`, which would throw a Zod / dotenv /
  // ParameterNotFound error because the required var was absent from
  // the subprocess environment.
  //
  // The allowlist's threat model was also weak. Secrets reach the
  // workflow env because the user put them there; the CLI uses them
  // for local synthesis + sends findings to CDK Insights servers,
  // never leaking env contents. Defensive filtering belongs one layer
  // down, in the sensitive-data scanner that redacts CloudFormation
  // template contents before sending to the backend.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // Keep CI=true on top — GitHub sets it, but belt and braces for
  // projects that rely on the CLI auto-detecting a CI environment.
  env.CI = 'true';

  // Set license key if provided (controls AI analysis in the CLI)
  if (licenseKey) {
    env.CDK_INSIGHTS_LICENSE_KEY = licenseKey;
  }

  const exitCode = await exec.exec('cdk-insights', args, {
    cwd: workingDirectory,
    env,
    ignoreReturnCode: true,
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

/**
 * Find auto-generated report files matching {stackName}_analysis_report.{ext}
 */
function findReportFiles(dir: string, ext: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const suffix = `${REPORT_SUFFIX}.${ext}`;
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => path.join(dir, f));
}

async function run(): Promise<void> {
  try {
    const inputs = parseInputs();

    core.startGroup('Setup');
    const resolvedVersion = await installCdkInsights(inputs.cdkInsightsVersion);
    core.endGroup();

    // Warn if AI requested without license
    if (inputs.aiAnalysis && !inputs.licenseKey) {
      core.warning(
        'AI analysis requested but no license key provided - using static analysis only',
      );
    }

    // CLI >= 1.44.0 writes every requested report file in a single pass via
    // --reports. Older CLIs need a separate scan per format, so SARIF falls
    // back to a second run and markdown can't be produced at all.
    const supportsReports = versionGte(
      resolvedVersion,
      REPORTS_FLAG_MIN_VERSION,
    );

    // Extra report files to request in the single pass: SARIF only when we'll
    // upload it, markdown only when it'll be kept as an artifact.
    const extraReports: ExtraReportFormat[] = [];
    if (supportsReports) {
      if (inputs.sarifUpload) extraReports.push('sarif');
      if (inputs.uploadArtifact) extraReports.push('markdown');
    }

    const args = buildScanArgs(inputs, extraReports);

    core.startGroup('Running CDK Insights Analysis');
    core.info(`Command: cdk-insights ${args.join(' ')}`);

    const { exitCode, stdout, stderr } = await runAnalysis(
      args,
      inputs.workingDirectory,
      inputs.licenseKey,
    );

    if (stdout) {
      core.info(stdout);
    }
    if (stderr) {
      core.warning(stderr);
    }
    core.endGroup();

    // Find auto-generated JSON report files
    const jsonFiles = findReportFiles(inputs.workingDirectory, 'json');

    // Distinguish CLI crash from normal analysis results
    if (exitCode !== 0 && jsonFiles.length === 0) {
      const errorMsg =
        stderr.trim() ||
        stdout.trim() ||
        `cdk-insights exited with code ${exitCode}`;
      throw new Error(`CDK Insights CLI failed: ${errorMsg}`);
    }

    if (jsonFiles.length === 0) {
      core.warning('No analysis report files found');
    } else {
      core.info(
        `Found ${jsonFiles.length} report file(s): ${jsonFiles.join(', ')}`,
      );
    }

    // Parse and aggregate results from all report files. Counts split
    // into totals (for display) and gating (for fail-on) so Reliability
    // or Cost findings never block a deploy unless the user opts in
    // via `fail-on-pillars`.
    core.startGroup('Processing Results');
    const results = aggregateResults(jsonFiles, inputs.failOnPillars);

    // Resolve SARIF files if requested. In single-pass mode the CLI already
    // wrote them in the run above; on older CLIs we do a dedicated SARIF pass.
    // Either way, selectSarifFiles collapses the per-stack + consolidated set
    // to a single non-duplicating upload.
    let sarifFiles: string[] = [];
    if (inputs.sarifUpload) {
      if (supportsReports) {
        sarifFiles = selectSarifFiles(
          findReportFiles(inputs.workingDirectory, 'sarif'),
        );
        if (sarifFiles.length > 0) {
          core.info(`SARIF file(s) generated: ${sarifFiles.join(', ')}`);
        } else {
          core.warning(
            'SARIF upload requested but no SARIF files were produced',
          );
        }
      } else {
        core.info(
          'Generating SARIF output (second pass — cdk-insights < 1.44.0)...',
        );

        const sarifArgs = buildSarifArgs(inputs);
        const sarifResult = await runAnalysis(
          sarifArgs,
          inputs.workingDirectory,
          inputs.licenseKey,
        );

        sarifFiles = selectSarifFiles(
          findReportFiles(inputs.workingDirectory, 'sarif'),
        );
        if (sarifResult.exitCode !== 0 && sarifFiles.length === 0) {
          core.warning(
            `SARIF generation failed: ${sarifResult.stderr.trim() || `exit code ${sarifResult.exitCode}`}`,
          );
        } else if (sarifFiles.length > 0) {
          core.info(`SARIF file(s) generated: ${sarifFiles.join(', ')}`);
        } else {
          core.warning(
            'SARIF generation requested but no SARIF files were produced',
          );
        }
      }
    }

    // Auto-upload SARIF to GitHub Code Scanning (Security tab)
    if (sarifFiles.length > 0 && inputs.githubToken) {
      core.startGroup('Uploading SARIF to Code Scanning');
      await uploadSarifToCodeScanning(sarifFiles, inputs.githubToken);
      core.endGroup();
    }

    // Upload all report files as a GitHub artifact
    let artifactId: number | null = null;
    if (inputs.uploadArtifact) {
      core.startGroup('Uploading Report Artifacts');
      const markdownFiles = findReportFiles(inputs.workingDirectory, 'md');
      const allReportFiles = [...jsonFiles, ...sarifFiles, ...markdownFiles];
      artifactId = await uploadReportArtifacts(
        allReportFiles,
        inputs.artifactName,
        inputs.workingDirectory,
      );
      core.endGroup();
    }

    setOutputs(
      results,
      jsonFiles,
      inputs.failOn,
      inputs.failOnClass,
      sarifFiles,
      artifactId,
    );
    core.endGroup();

    // Check fail conditions. The severity counts used here are already
    // pillar-scoped (see aggregateResults) so e.g. a Reliability
    // CRITICAL never triggers a failure under the default
    // fail-on-pillars: security.
    const pillarScope =
      inputs.failOnPillars === 'all'
        ? 'all pillars'
        : inputs.failOnPillars.join(', ');

    const failReasons: string[] = [];

    // Severity gate (pillar-scoped) — only when fail-on is configured.
    if (inputs.failOn.length > 0) {
      const failConditions: string[] = [];
      const gating = results.gatingCounts;

      if (inputs.failOn.includes('critical') && gating.criticalCount > 0) {
        failConditions.push(`${gating.criticalCount} critical`);
      }
      if (inputs.failOn.includes('high') && gating.highCount > 0) {
        failConditions.push(`${gating.highCount} high`);
      }
      if (inputs.failOn.includes('medium') && gating.mediumCount > 0) {
        failConditions.push(`${gating.mediumCount} medium`);
      }
      if (inputs.failOn.includes('low') && gating.lowCount > 0) {
        failConditions.push(`${gating.lowCount} low`);
      }

      if (failConditions.length > 0) {
        failReasons.push(
          `severity (${pillarScope}): ${failConditions.join(', ')}`,
        );
      }
    }

    // Finding-class gate — orthogonal to severity and pillar. Blocks on real
    // risk (security/compliance) while best-practice advice can stay advisory.
    if (inputs.failOnClass.length > 0) {
      const classHits = inputs.failOnClass
        .filter((c) => (results.classCounts[c] ?? 0) > 0)
        .map((c) => `${results.classCounts[c]} ${c}`);
      if (classHits.length > 0) {
        failReasons.push(`finding class: ${classHits.join(', ')}`);
      }
    }

    if (failReasons.length > 0) {
      core.setFailed(
        `Analysis found blocking issues — ${failReasons.join('; ')}`,
      );
      return;
    }

    // Success summary
    const totals = results.totalCounts;
    core.info('');
    core.info('='.repeat(50));
    core.info('CDK Insights Analysis Complete');
    core.info('='.repeat(50));
    core.info(`Total Issues: ${results.totalIssues}`);
    core.info(`  Critical: ${totals.criticalCount}`);
    core.info(`  High: ${totals.highCount}`);
    core.info(`  Medium: ${totals.mediumCount}`);
    core.info(`  Low: ${totals.lowCount}`);
    core.info(`Fail-on pillars: ${pillarScope}`);
    if (inputs.failOnClass.length > 0) {
      core.info(`Fail-on classes: ${inputs.failOnClass.join(', ')}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

run();
