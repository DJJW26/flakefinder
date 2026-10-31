/**
 * GitHub Action entry point: wires the real @actions/* services into
 * runAction (main.ts), which holds the whole — tested — flow.
 */
import path from 'node:path';
import * as artifact from '@actions/artifact';
import * as cache from '@actions/cache';
import * as core from '@actions/core';
import { runAction } from './main.js';

async function expandGlobs(patterns: string[], cwd: string): Promise<string[]> {
  const globModule = await import('@actions/glob');
  const globber = await globModule.create(patterns.join('\n'), { matchDirectories: false });
  const paths: string[] = await globber.glob();
  return paths.map((p: string) => path.resolve(cwd, p));
}

runAction({
  env: process.env,
  baseDir: process.cwd(),
  core: {
    info: (m) => core.info(m),
    warning: (m) => core.warning(m),
    setFailed: (m) => core.setFailed(m),
    setOutput: (name, value) => core.setOutput(name, value),
    writeSummary: async (html) => {
      await core.summary.addRaw(html).write();
    },
  },
  cache,
  uploadArtifact: (name, files, root) =>
    new artifact.DefaultArtifactClient().uploadArtifact(name, files, root, { retentionDays: 30 }),
  glob: expandGlobs,
  fetchImpl: fetch,
  // @actions/glob resolves relative patterns against process.cwd()
  chdir: (dir) => process.chdir(dir),
}).catch((err: Error) => {
  core.setFailed(`flakefinder action: ${err.message}`);
});
