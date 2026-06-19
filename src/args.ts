import { ActionInputs } from './inputs';

/**
 * Extra report-file formats the CLI's `--reports` flag understands. JSON is
 * always the primary `--format`, so it's never passed here.
 */
export type ExtraReportFormat = 'sarif' | 'markdown';

/**
 * Build CLI arguments for the main scan command.
 *
 * `extraReports` are written in the same pass via `--reports` (CLI >= 1.44.0).
 * For older CLIs the caller omits them and falls back to a second `scan` run
 * built with {@link buildSarifArgs}.
 *
 * Pure function — no side effects, fully testable.
 */
export function buildScanArgs(
  inputs: ActionInputs,
  extraReports: ExtraReportFormat[] = [],
): string[] {
  const args: string[] = ['scan'];

  // Skip interactive prompts in CI
  args.push('--yes');

  // Disable CLI's built-in failOnCritical so the action controls failure
  args.push('--no-failOnCritical');

  // Allow analysis to continue when sensitive data is detected (the action
  // controls failure via the fail-on input). Without this flag the CLI exits
  // before posting PR comments or generating reports.
  args.push('--warn-sensitive');

  // AI analysis is controlled by CDK_INSIGHTS_LICENSE_KEY env var (no --ai flag in CLI)
  // Use --local to force static-only analysis when user has a license but wants to skip AI
  if (!inputs.aiAnalysis && inputs.licenseKey) {
    args.push('--local');
  }

  // PR comment (uses gh CLI, which auto-authenticates via GITHUB_TOKEN in GitHub Actions)
  if (inputs.prComment) {
    args.push('--prComment');
  }

  // Services filter (yargs array type — pass as individual args)
  if (inputs.services.length > 0) {
    args.push('--services', ...inputs.services);
  }

  // Rule filter (yargs array type — pass as individual args)
  if (inputs.ruleFilter.length > 0) {
    args.push('--ruleFilter', ...inputs.ruleFilter);
  }

  // Output as JSON (CLI auto-generates {stackName}_analysis_report.json).
  // This is the action's machine-readable source of truth for counts.
  args.push('--format', 'json');

  // Single-pass extra reports (CLI >= 1.44.0). Writes the SARIF and/or
  // Markdown report files alongside the JSON one without a second scan,
  // so we don't re-synthesize, re-run AI, or upload a duplicate scan to
  // scan history. yargs array option — pass each value as its own arg.
  if (extraReports.length > 0) {
    args.push('--reports', ...extraReports);
  }

  // Stack selection goes LAST. The `--` separator stops a flag-like stack
  // name from being parsed as an option (defence-in-depth on top of the
  // input validation), but everything after `--` is treated as positional —
  // so it must come after every flag, or the flags get swallowed too.
  appendStackSelection(args, inputs);

  return args;
}

/**
 * Append stack selection to the end of an args list: `--all`, or a
 * `--`-guarded positional stack name. Must be the final thing pushed (see
 * {@link buildScanArgs}).
 */
function appendStackSelection(args: string[], inputs: ActionInputs): void {
  if (inputs.stackName) {
    args.push('--', inputs.stackName);
  } else {
    args.push('--all');
  }
}

/**
 * Build CLI arguments for a standalone SARIF generation run.
 *
 * Only used as a fallback for CLI versions older than 1.44.0, which can't
 * emit more than one report format per pass. Newer CLIs get SARIF in the
 * single {@link buildScanArgs} run via `--reports`.
 */
export function buildSarifArgs(inputs: ActionInputs): string[] {
  const args: string[] = ['scan'];

  args.push('--yes');
  args.push('--no-failOnCritical');
  args.push('--warn-sensitive');

  // Match the primary run's AI/static decision so the SARIF reflects the
  // same findings as the JSON report (e.g. don't run AI here if the main
  // run was forced local).
  if (!inputs.aiAnalysis && inputs.licenseKey) {
    args.push('--local');
  }

  args.push('--format', 'sarif');

  // Stack selection last — see buildScanArgs / appendStackSelection.
  appendStackSelection(args, inputs);

  return args;
}
