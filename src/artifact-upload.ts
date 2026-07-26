import * as path from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';
import * as core from '@actions/core';

/**
 * Upload report files as a GitHub Actions artifact.
 * Returns the artifact ID on success, or null if no files or upload fails.
 */
export async function uploadReportArtifacts(
  filePaths: string[],
  artifactName: string,
  rootDirectory: string,
): Promise<number | null> {
  if (filePaths.length === 0) {
    core.info('No report files to upload as artifact');
    return null;
  }

  try {
    const client = new DefaultArtifactClient();
    const absRoot = path.resolve(rootDirectory);

    const { id, size } = await client.uploadArtifact(
      artifactName,
      filePaths,
      absRoot,
      { retentionDays: 90 },
    );

    if (id != null) {
      const sizeStr = size != null ? ` ${(size / 1024).toFixed(1)} KB,` : '';
      core.info(
        `Artifact "${artifactName}" uploaded (ID: ${id},${sizeStr} ${filePaths.length} file(s))`,
      );
      return id;
    }

    core.warning('Artifact upload completed but no artifact ID was returned');
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to upload artifact: ${message}`);
    return null;
  }
}
