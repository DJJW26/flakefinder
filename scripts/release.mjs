/**
 * Release automation (C4): `node scripts/release.mjs <version> [--push]`
 *
 * Bumps the version in BOTH places (package.json + src/types.ts), inserts a
 * CHANGELOG stub, runs the full pipeline, rebuilds dist, commits, and tags.
 * With --push it also pushes main + tags (CI then publishes to npm via the
 * release workflow when NPM_TOKEN is configured).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
const push = process.argv.includes('--push');

if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: node scripts/release.mjs <version> [--push]   (semver, e.g. 1.0.0)');
  process.exit(2);
}

function run(cmd, args) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  // npx/npm are .cmd shims on Windows — execFileSync needs a shell for them
  const needsShell = process.platform === 'win32' && /^(npx|npm)$/.test(cmd);
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: needsShell });
}

// 1. idempotency guard: version must actually change
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (pkg.version === version && !process.argv.includes('--force')) {
  console.error(`already at ${version} — pass a new version (or --force)`);
  process.exit(2);
}

// 2. bump BOTH places (the two-version trap)
pkg.version = version;
writeFileSync(path.join(ROOT, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
const typesPath = path.join(ROOT, 'src', 'types.ts');
const types = readFileSync(typesPath, 'utf8');
if (!new RegExp(`FLAKEFINDER_VERSION = '${version.replace(/\./g, '\\.')}'`).test(types)) {
  writeFileSync(
    typesPath,
    types.replace(/FLAKEFINDER_VERSION = '[^']+';/, `FLAKEFINDER_VERSION = '${version}';`),
    'utf8',
  );
}

// 3. CHANGELOG stub (release notes get filled in above it)
const changelogPath = path.join(ROOT, 'CHANGELOG.md');
const changelog = readFileSync(changelogPath, 'utf8');
if (!changelog.startsWith(`## ${version}`)) {
  writeFileSync(
    changelogPath,
    `## ${version}\n\n- _(fill in before tagging — this stub is created by scripts/release.mjs)_\n\n${changelog}`,
    'utf8',
  );
}

// 4. full pipeline
run('npx', ['vitest', 'run']);
run('npx', ['tsc', '-p', '.']);
run('npx', ['biome', 'check', 'src', 'tests']);
run('npm', ['run', 'build']);
run('node', ['scripts/perf-smoke.mjs']);
run('node', ['scripts/e2e.mjs']);

// 5. commit + tag
run('git', ['add', '-A']);
run('git', ['update-index', '--chmod=+x', 'dist/cli.js']);
run('git', ['commit', '-m', `release: v${version}`]);
run('git', ['tag', `v${version}`]);

if (push) {
  run('git', ['push', 'origin', 'main', '--tags']);
  console.log(`\nv${version} pushed — CI will verify; the release workflow publishes to npm when NPM_TOKEN is set.`);
} else {
  console.log(`\nv${version} tagged locally. Review, then: git push origin main --tags`);
}
