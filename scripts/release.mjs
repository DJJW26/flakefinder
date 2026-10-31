/**
 * Release automation (C4): `node scripts/release.mjs <version> [--push]`
 *
 * Bumps the version everywhere it lives (package.json, package-lock.json's
 * root entries, src/types.ts), inserts a CHANGELOG stub under the title,
 * runs the full pipeline, rebuilds dist, commits, and tags. With --push it
 * also pushes main + tags (CI then publishes to npm via the release workflow
 * when NPM_TOKEN is configured).
 *
 * The pure helpers are exported for tests; importing this module does not
 * run a release.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Insert a `## <version>` stub BELOW the `# Changelog` title (and the blank
 * lines after it), above the newest entry. No-op when that version already
 * has a section anywhere in the file.
 */
export function insertChangelogStub(changelog, version) {
  if (new RegExp(`^## ${escapeRe(version)}[ \\t]*\\r?$`, 'm').test(changelog)) return changelog;
  const stub = `## ${version}\n\n- _(fill in before tagging — this stub is created by scripts/release.mjs)_\n\n`;
  const title = changelog.match(/^# [^\n]*\n(?:[ \t]*\r?\n)*/);
  if (!title) return `${stub}${changelog}`;
  const end = title[0].length;
  const head = title[0].endsWith('\n\n') || title[0].endsWith('\r\n\r\n') ? title[0] : `${title[0]}\n`;
  return `${head}${stub}${changelog.slice(end)}`;
}

/** package-lock.json text with BOTH root version fields bumped (`version`, `packages[""].version`). */
export function bumpLockfile(lockText, version) {
  const lock = JSON.parse(lockText);
  lock.version = version;
  if (lock.packages && lock.packages[''] && typeof lock.packages[''] === 'object') {
    lock.packages[''].version = version;
  }
  return `${JSON.stringify(lock, null, 2)}\n`;
}

function run(cmd, args) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  // npx/npm are .cmd shims on Windows — execFileSync needs a shell for them
  const needsShell = process.platform === 'win32' && /^(npx|npm)$/.test(cmd);
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: needsShell });
}

function main() {
  const version = process.argv[2];
  const push = process.argv.includes('--push');

  if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    console.error('usage: node scripts/release.mjs <version> [--push]   (semver, e.g. 1.0.0)');
    process.exit(2);
  }

  // 1. idempotency guard: version must actually change
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.version === version && !process.argv.includes('--force')) {
    console.error(`already at ${version} — pass a new version (or --force)`);
    process.exit(2);
  }

  // 2. bump EVERY place (the two-version trap — and the lockfile root)
  pkg.version = version;
  writeFileSync(path.join(ROOT, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  const lockPath = path.join(ROOT, 'package-lock.json');
  if (existsSync(lockPath)) {
    writeFileSync(lockPath, bumpLockfile(readFileSync(lockPath, 'utf8'), version), 'utf8');
  }
  const typesPath = path.join(ROOT, 'src', 'types.ts');
  const types = readFileSync(typesPath, 'utf8');
  if (!new RegExp(`FLAKEFINDER_VERSION = '${escapeRe(version)}'`).test(types)) {
    writeFileSync(
      typesPath,
      types.replace(/FLAKEFINDER_VERSION = '[^']+';/, `FLAKEFINDER_VERSION = '${version}';`),
      'utf8',
    );
  }

  // 3. CHANGELOG stub under the title (release notes get filled in there)
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  const updated = insertChangelogStub(changelog, version);
  if (updated !== changelog) writeFileSync(changelogPath, updated, 'utf8');

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
    console.log(
      `\nv${version} pushed — CI will verify; the release workflow publishes to npm when NPM_TOKEN is set.`,
    );
  } else {
    console.log(`\nv${version} tagged locally. Review, then: git push origin main --tags`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
