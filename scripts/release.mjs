import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = 'package.json';
const LOCKFILE = 'package-lock.json';
const TYPES = 'src/types.ts';
const CHANGELOG = 'CHANGELOG.md';
const USAGE = 'Usage: node scripts/release.mjs <version> or --validate-tag <vX.Y.Z>';

// npm normalizes away build metadata, so release versions support the core
// version and optional prerelease only.
function requireVersion(version) {
  const pattern =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
  const match = pattern.exec(version);
  if (
    !match ||
    match[0] !== version ||
    version.length > 256 ||
    !match.slice(1, 4).every((part) => Number.isSafeInteger(Number(part))) ||
    match[4]?.split('.').some((id) => /^0\d+$/.test(id))
  ) {
    throw new Error(
      `Invalid release version ${JSON.stringify(version)}. Use X.Y.Z or X.Y.Z-prerelease.`,
    );
  }
}

function requireTag(tag) {
  if (!tag.startsWith('v')) throw new Error('Release tags must start with v.');
  const version = tag.slice(1);
  requireVersion(version);
  return version;
}

function releaseNotes(changelog, version) {
  const sections = [];
  let current;
  for (const line of changelog.split(/\r?\n/)) {
    if (/^##[ \t]/.test(line)) {
      current = line.trimEnd() === `## ${version}` ? [] : undefined;
      if (current) sections.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  if (sections.length !== 1) {
    throw new Error(`${CHANGELOG} must contain exactly one "## ${version}" section.`);
  }
  const notes = sections[0].join('\n').trim();
  const content = notes.replace(/<!--[\s\S]*?-->/g, '');
  const lines = content.split('\n');
  const placeholder = /^[\s>*_#`+-]*(?:todo|tbd|placeholder)\b(?:[\s*_:.!?`-]*|[\s*_`]*:[ \t].*)$/i;
  if (
    /fill in before tagging/i.test(notes) ||
    lines.some((line) => placeholder.test(line)) ||
    !lines.some((line) => !/^\s*#/.test(line) && /[\p{L}\p{N}]/u.test(line))
  ) {
    throw new Error(
      `Write release notes for ${version} in ${CHANGELOG} before preparing or tagging.`,
    );
  }
  return notes;
}

function read(file) {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

function readProject() {
  const pkg = JSON.parse(read(PACKAGE));
  const lock = JSON.parse(read(LOCKFILE));
  const source = read(TYPES);
  const constants = [
    ...source.matchAll(/^(export const FLAKEFINDER_VERSION = ')([^']+)(';)[ \t]*\r?$/gm),
  ];
  if (constants.length !== 1)
    throw new Error(`${TYPES} must declare FLAKEFINDER_VERSION exactly once.`);
  return { pkg, lock, source, sourceVersion: constants[0] };
}

function checkVersions(version, { pkg, lock, sourceVersion }) {
  const versions = {
    [PACKAGE]: pkg.version,
    [LOCKFILE]: lock.version,
    [`${LOCKFILE} (root package)`]: lock.packages?.['']?.version,
    [`${TYPES} (FLAKEFINDER_VERSION)`]: sourceVersion[2],
  };
  const problems = Object.entries(versions).filter(([, actual]) => actual !== version);
  if (problems.length) {
    const details = problems.map(([file, actual]) => `  ${file}: ${actual ?? '(missing)'}`);
    throw new Error(
      `Expected release version ${version} in all version files. Found:\n${details.join('\n')}`,
    );
  }
  if (pkg.name !== 'flakefinder' || lock.name !== pkg.name || lock.packages[''].name !== pkg.name) {
    throw new Error('Release manifests must agree on the npm package name flakefinder.');
  }
}

function runNpm(script, env = process.env) {
  const commandLine = `npm run ${script}`;
  console.log(`  $ ${commandLine}`);
  const options = { cwd: ROOT, stdio: 'inherit', env };
  // npm is a .cmd shim on Windows. Callers only pass fixed script names.
  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', commandLine], options);
  } else {
    execFileSync('npm', ['run', script], options);
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function prepare(version) {
  requireVersion(version);
  if (git(['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('Start with a clean working tree and commit the reviewed changelog first.');
  }
  if (git(['tag', '--list', `v${version}`])) {
    throw new Error(`Tag v${version} already exists locally.`);
  }

  releaseNotes(read(CHANGELOG), version);
  const project = readProject();
  requireVersion(project.pkg.version);
  checkVersions(project.pkg.version, project);
  if (project.pkg.version === version) throw new Error(`Already at version ${version}.`);

  const { pkg, lock, source, sourceVersion } = project;
  pkg.version = version;
  lock.version = version;
  lock.packages[''].version = version;
  writeFileSync(path.join(ROOT, PACKAGE), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(path.join(ROOT, LOCKFILE), `${JSON.stringify(lock, null, 2)}\n`);
  const start = sourceVersion.index + sourceVersion[1].length;
  const updatedSource =
    source.slice(0, start) + version + source.slice(start + sourceVersion[2].length);
  writeFileSync(path.join(ROOT, TYPES), updatedSource);

  for (const script of ['test', 'typecheck', 'lint', 'build', 'perf']) {
    runNpm(script);
  }
  runNpm('e2e', { ...process.env, FF_E2E_STRICT: '1', FF_E2E_NOBUILD: '1' });
  checkVersions(version, readProject());
  console.log(`Prepared ${version}. Review the changes and open a release PR before tagging.`);
}

// A publish can reach npm before the runner records success. On a rerun,
// resume only when the registry's immutable version is the same tarball.
async function publicationStatus(tag, tarball) {
  const version = requireTag(tag);
  const expected = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
  const response = await fetch(`https://registry.npmjs.org/flakefinder/${version}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return 'unpublished';
  if (!response.ok) throw new Error(`npm registry lookup failed (HTTP ${response.status}).`);
  const pkg = await response.json();
  if (pkg?.name !== 'flakefinder' || pkg.version !== version || pkg.dist?.integrity !== expected) {
    throw new Error(`Published flakefinder@${version} does not match the verified tarball.`);
  }
  if (!pkg.dist.attestations?.provenance) {
    throw new Error(`Published flakefinder@${version} has no provenance attestation.`);
  }
  return 'published';
}

async function main(args) {
  if (args.length === 3 && args[0] === '--publication-status') {
    console.log(await publicationStatus(args[1], args[2]));
  } else if (args.length === 2 && args[0] === '--validate-tag') {
    const version = requireTag(args[1]);
    checkVersions(version, readProject());
    process.stdout.write(`${releaseNotes(read(CHANGELOG), version)}\n`);
  } else if (args.length === 1 && !args[0].startsWith('-')) {
    prepare(args[0]);
  } else {
    throw new Error(USAGE);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
