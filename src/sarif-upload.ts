import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as core from '@actions/core';
import * as github from '@actions/github';

/**
 * Upload SARIF files to GitHub Code Scanning via the REST API.
 * Requires the workflow to have `security-events: write` permission.
 * Gracefully warns on failure (e.g., private repo without GitHub Advanced Security).
 */
export async function uploadSarifToCodeScanning(
  sarifPaths: string[],
  token: string,
): Promise<void> {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const commitSha = github.context.sha;
  const ref = github.context.ref;
  const checkoutUri = pathToFileURL(
    `${process.env.GITHUB_WORKSPACE || process.cwd()}/`,
  ).href;

  for (const sarifPath of sarifPaths) {
    const fileName = path.basename(sarifPath);
    try {
      const content = readFileSync(sarifPath, 'utf8');
      const compressed = gzipSync(content).toString('base64');

      const { data } = await octokit.rest.codeScanning.uploadSarif({
        owner,
        repo,
        commit_sha: commitSha,
        ref,
        checkout_uri: checkoutUri,
        sarif: compressed,
      });

      core.info(
        `SARIF uploaded to Code Scanning: ${fileName} (ID: ${data.id})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(
        `Failed to upload SARIF to Code Scanning (${fileName}): ${message}. ` +
          'Ensure the workflow has security-events: write permission and ' +
          'GitHub Code Security is enabled for private repos.',
      );
    }
  }
}
