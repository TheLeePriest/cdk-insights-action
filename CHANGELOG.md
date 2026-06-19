# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.1] - 2026-06-19

### Fixed

Two pre-existing bugs surfaced by end-to-end testing against a real multi-stack CDK app. The action now documents a minimum supported CLI of **cdk-insights >= 1.44.1** (single-pass reports, `fail-on-class`, and `stack-name` scoping all depend on it; the action degrades gracefully on older CLIs).

- **Tool-cache hits couldn't find the CLI.** On a warm `@actions/tool-cache` (subsequent runs on self-hosted runners, or any runner with a populated tool cache), the cache-hit branch added `<cached>/bin` to `PATH`, but the binary lives at `<cached>/node_modules/.bin` (where the install branch correctly points). Cached runs failed with "Unable to locate executable file: cdk-insights". GitHub-hosted runners start with a cold cache each job, which is why it went unnoticed. The cached path is now correct and the binary's presence is verified before use (reinstalls if the cache is incomplete).
- **Specifying `stack-name` silently disabled every flag.** The `--` separator and stack name were emitted *before* the flags, so `--format`, `--reports`, `--warn-sensitive`, `--no-failOnCritical`, and `--prComment` all landed after `--` and were parsed as positional arguments rather than options — meaning no SARIF/markdown, no sensitive-data warning behaviour, etc. Stack selection is now emitted last, after all flags.

## [1.5.0] - 2026-06-19

### Added

- `fail-on-class` input — fail the build on findings of a given **finding class** (`security`, `best-practice`, `compliance`), independent of severity and pillar. This complements `fail-on` / `fail-on-pillars`: a team can block on real risk (security / compliance) while best-practice advice stays advisory, even at the same severity. Gated action-side from the `findingClass` field the CLI emits (cdk-insights >= 1.43.0); older CLIs emit no class data, so the gate is a safe no-op. The `exit-code` output also reflects the class gate.

### Changed

- **Single-pass report generation (cdk-insights >= 1.44.0).** When SARIF and/or artifact reports are requested, the action now runs `cdk-insights scan` **once** with `--reports`, which writes the JSON, SARIF, and Markdown report files in a single analysis pass. Previously the action ran the CLI a second time purely to produce SARIF — re-synthesizing, re-running rules/AI, and (for licensed users) uploading a duplicate scan to scan history on every run. The action falls back to the previous two-run behaviour automatically on CLI versions older than 1.44.0.
- **Markdown report is now actually produced.** Because the single pass emits Markdown alongside JSON and SARIF, the `{stack}_analysis_report.md` files are now included in the uploaded artifact as documented. (Under the old json-only / sarif-only runs the CLI never wrote a Markdown report, so the artifact silently contained none.)

### Fixed

- **Duplicate SARIF uploads in multi-stack mode.** In `--all` mode the CLI writes a per-stack `{stack}_analysis_report.sarif` for every stack *and* a `consolidated_analysis_report.sarif` containing the union. The action uploaded all of them to GitHub Code Scanning, double-reporting every finding. It now uploads only the consolidated file when present (falling back to the per-stack file for single-stack runs). The same de-duplication applies to the report artifact.
- The legacy SARIF fallback run now mirrors the primary run's `--local` decision, so a license-holder who set `ai-analysis: false` no longer triggers AI analysis (and AI-credit spend) during SARIF generation.

## [1.4.0] - 2026-04-21

### Added

- `fail-on-pillars` input to scope the fail-on gate by AWS Well-Architected pillar. Defaults to `security`, so Reliability, Cost, Operational Excellence, Performance Efficiency, and Sustainability findings are surfaced in the report but no longer block the deploy. Accepts a comma-separated list of pillar names, or the shorthand `all`. Matches how other scanners (Snyk, SonarQube, Trivy) separate "found something" from "fail the build". No workflow change is required for existing consumers — the default behaviour is the correct default for most projects.

### Changed

- `AnalysisResults` now carries both `totalCounts` (for display and outputs) and `gatingCounts` (for exit-code gating). The `critical-count`/`high-count`/`medium-count`/`low-count` outputs still reflect full totals so PR comments and badges never hide findings, while the exit code honours `fail-on-pillars`.
- Per-stack reports are now always walked via `recommendations[].issues[]` rather than the summary block, so the pillar filter is applied accurately. Summary-only reports from older CLI versions fall back to unfiltered gating to avoid under-reporting.

## [1.3.1] - 2026-04-21

### Fixed

- Forward the full workflow environment to the `cdk-insights` CLI subprocess. The previous `ENV_ALLOWLIST` (PATH, HOME, GITHUB_*, etc.) stripped every variable a non-trivial CDK app reads at synth time — AWS credentials (`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`), CDK targeting (`CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION`), and project-specific config (e.g. `STAGE`, `STRIPE_EVENT_SOURCE_NAME`, `TARGET_EVENT_BUS_NAME`). Users saw Zod / dotenv / `ParameterNotFound` errors during `cdk synth` because the CLI subprocess couldn't see the env vars their workflow had set. The CLI now inherits the workflow environment; secrets never leave the runner and the sensitive-data scanner redacts template contents before transmission. `CI=true` and `CDK_INSIGHTS_LICENSE_KEY` are still set explicitly.

## [1.2.0] - 2026-02-11

### Security

- Restricted subprocess environment to an allowlist of 15 variables instead of forwarding the entire `process.env`
- Added input validation for `stack-name`, `services`, `rule-filter`, and `cdk-insights-version` to prevent argument injection
- Added path traversal protection for `working-directory` (must resolve within `GITHUB_WORKSPACE`)
- Added `--` separator before positional stack name arguments to prevent flag injection
- Fixed CI workflow expression injection — step outputs now use `env:` block instead of inline `${{ }}`
- Fixed release workflow script injection — version variable is quoted and validated against semver pattern
- Added `permissions: contents: read` to CI workflow for least-privilege
- Pinned npm registry (`--registry https://registry.npmjs.org`) for `npm view` and `npm install`
- Removed unused `@actions/github` dependency (eliminates vulnerable `undici` transitive dependency)

### Added

- 11 new input validation tests (52 total tests)
- Empty string filtering for comma-separated `services` and `rule-filter` inputs

## [1.1.0] - 2026-02-11

### Added

- Tool caching for cdk-insights CLI — subsequent runs skip npm install entirely
- CLI crash detection — distinguishes between analysis findings and CLI failures
- Unit tests for inputs, outputs, and arg building (41 tests via vitest)
- `ai-analysis: false` now passes `--local` to force static-only analysis with a license key
- CI checks that `dist/` is up to date and validates action outputs
- `--all --yes` flags for CI-safe multi-stack analysis when no stack name is provided

### Fixed

- Removed `--ai` flag which does not exist in the cdk-insights CLI
- Removed `--outputFile` flag which does not exist in the CLI; action now discovers auto-generated report files
- Removed broken SARIF upload via `npx @github/codeql-action`; SARIF files are now generated for users to upload via `github/codeql-action/upload-sarif@v3`
- Fixed conflicting `--output` CLI flags when additional output format was requested
- Fixed `--services` and `--ruleFilter` arg passing to use yargs array format
- Fixed `exit-code` output to respect `fail-on` severity configuration
- Fixed `process.env` type safety (removed unsafe type assertion)
- Fixed org references from `cdkinsights` to `TheLeePriest` in release workflow and README
- Added `core.setSecret()` to mask license key in logs
- Disabled CLI's built-in `--failOnCritical` so the action controls failure thresholds consistently
- Passed `GITHUB_TOKEN` through environment for `gh` CLI PR comment authentication

### Changed

- Uses `--format` (preferred alias) instead of `--output` for CLI format flag
- Upgraded `softprops/action-gh-release` from v1 to v2 in release workflow
- Updated `sarif-upload` input description to reflect generation-only behavior
- Removed unused `output-format` and `output-file` inputs
- Replaced `@actions/io` with `@actions/tool-cache` for installation
- README fully updated to match current inputs, outputs, and usage patterns

## [1.0.0] - 2026-02-05

### Added

- Initial release of CDK Insights GitHub Action
- Static analysis of AWS CDK infrastructure
- AI-powered analysis with license key
- PR comment summaries with severity breakdown
- SARIF upload for GitHub Code Scanning integration
- Configurable failure thresholds by severity level
- Support for filtering by AWS services
- Support for filtering by rule IDs
- Outputs for issue counts and file paths
- Support for monorepo setups with `working-directory` input
- Configurable cdk-insights version

### Features

- **Security scanning** - Detect misconfigurations and vulnerabilities
- **Cost optimization** - Find opportunities to reduce AWS spend
- **Best practices** - Ensure CDK patterns follow AWS Well-Architected Framework
- **PR comments** - Automatic summary posted on pull requests
- **Code scanning** - SARIF integration with GitHub Security tab
