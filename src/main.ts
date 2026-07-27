import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { logAnalysisOutput } from './analysis-logging';
import { buildSarifArgs, buildScanArgs, type ExtraReportFormat } from './args';
import { uploadReportArtifacts } from './artifact-upload';
import { runAnalysis } from './cli-runner';
import { parseInputs } from './inputs';
import { aggregateResults, buildFailReasons, setOutputs } from './outputs';
import {
  REPORT_SUFFIX,
  REPORTS_FLAG_MIN_VERSION,
  selectSarifFiles,
  versionGte,
} from './report-utils';
import { uploadSarifToCodeScanning } from './sarif-upload';

const AI_MODEL_FLAG_MIN_VERSION = '1.60.0';
const INTELLIGENCE_COMMANDS_MIN_VERSION = '1.61.0';

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
 * Install the cdk-insights CLI into the runner's temporary directory.
 * npm's own package cache avoids repeatedly downloading unchanged packages.
 * Returns the resolved (numeric) version so the caller can gate features.
 */
async function installCdkInsights(requestedVersion: string): Promise<string> {
  const version = await resolveVersion(requestedVersion);
  core.info(`Resolved cdk-insights version: ${version}`);

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
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
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

  core.addPath(binDir);

  core.info(`cdk-insights ${version} installed`);
  return version;
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

    if (
      inputs.aiModel &&
      !versionGte(resolvedVersion, AI_MODEL_FLAG_MIN_VERSION)
    ) {
      throw new Error(
        `The ai-model input requires cdk-insights >= ${AI_MODEL_FLAG_MIN_VERSION}; resolved ${resolvedVersion}. Remove the version pin or clear ai-model.`,
      );
    }

    const intelligenceEnabled =
      inputs.deploymentPreview ||
      !!inputs.policyFile ||
      inputs.reliabilityCheck ||
      inputs.liveCheck;
    if (
      intelligenceEnabled &&
      !versionGte(resolvedVersion, INTELLIGENCE_COMMANDS_MIN_VERSION)
    ) {
      throw new Error(
        `Deployment intelligence inputs require cdk-insights >= ${INTELLIGENCE_COMMANDS_MIN_VERSION}; resolved ${resolvedVersion}.`,
      );
    }

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

    logAnalysisOutput(stdout, stderr);
    core.endGroup();

    const guardrailFailures: string[] = [];
    const runGuardrail = async (label: string, command: string[]) => {
      core.startGroup(label);
      core.info(`Command: cdk-insights ${command.join(' ')}`);
      const result = await runAnalysis(
        command,
        inputs.workingDirectory,
        inputs.licenseKey,
      );
      logAnalysisOutput(result.stdout, result.stderr);
      core.endGroup();
      if (result.exitCode !== 0) guardrailFailures.push(label);
    };

    // The main scan has already synthesized the application. Reuse cdk.out
    // for every optional guardrail to avoid multiplying CI time and cost.
    if (inputs.deploymentPreview) {
      await runGuardrail('Deployment Risk Preview', [
        'preview',
        '--no-synth',
        '--out-dir',
        'cdk.out',
        '--baseline',
        inputs.deploymentBaseline,
        '--fail-on',
        inputs.deploymentFailOn,
      ]);
    }
    if (inputs.policyFile) {
      await runGuardrail('Infrastructure Policy Contract', [
        'policy',
        'check',
        '--no-synth',
        '--out-dir',
        'cdk.out',
        '--file',
        inputs.policyFile,
      ]);
    }
    if (inputs.reliabilityCheck) {
      await runGuardrail('Reliability Simulation', [
        'simulate',
        '--no-synth',
        '--out-dir',
        'cdk.out',
        '--fail-on-high',
      ]);
    }
    if (inputs.liveCheck) {
      await runGuardrail('Live AWS Drift and Risk', [
        'live',
        '--no-synth',
        '--out-dir',
        'cdk.out',
        '--fail-on',
        inputs.liveFailOn,
      ]);
    }

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
          'Generating SARIF output (second pass - cdk-insights < 1.44.0)...',
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

    const failReasons = buildFailReasons(
      results,
      inputs.failOn,
      inputs.failOnClass,
      inputs.failOnPillars,
    );

    if (failReasons.length > 0 || guardrailFailures.length > 0) {
      core.setFailed(
        [
          failReasons.length > 0
            ? `Analysis found blocking issues - ${failReasons.join('; ')}`
            : '',
          guardrailFailures.length > 0
            ? `Guardrails failed: ${guardrailFailures.join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join('; '),
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
