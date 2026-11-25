import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const WINDOWS = process.platform === 'win32';

function run(command, args, cwd, expectedStatus = 0) {
  // Only call cmd.exe for Windows batch shims. The inner quotes keep spaces
  // and the literal ">" argument intact as the installed shim forwards %*.
  const result = WINDOWS
    ? spawnSync(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/v:off', '/s', '/c', `"${[command, ...args].map((arg) => `"${arg}"`).join(' ')}"`],
        { cwd, env, encoding: 'utf8', timeout: 180_000, windowsVerbatimArguments: true },
      )
    : spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    expectedStatus,
    `${command} ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

const env = { ...process.env };
// The package and its live runner must use the same Node version as this job.
const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
env[pathKey] = [path.dirname(process.execPath), env[pathKey]].filter(Boolean).join(path.delimiter);
delete env.NODE_PATH;
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;

function ingestAndReport(cwd, cli, version) {
  const jest = {
    testResults: [
      {
        name: 'sample.test.js',
        status: 'passed',
        assertionResults: [
          {
            ancestorTitles: [],
            failureMessages: [],
            fullName: 'JSON passing case',
            status: 'passed',
            title: 'JSON passing case',
          },
        ],
      },
    ],
  };
  writeFileSync(path.join(cwd, 'jest result.json'), JSON.stringify(jest));
  writeFileSync(
    path.join(cwd, 'junit result.xml'),
    '<testsuite name="packed"><testcase name="XML failing case"><failure>failed</failure></testcase></testsuite>',
  );

  assert.match(
    cli(['ingest', 'jest result.json', 'junit result.xml']),
    /2 test result\(s\) from 2\/2/,
  );
  const report = JSON.parse(cli(['report', '--format', 'json']));
  assert.equal(report.flakefinderVersion, version);
  const outcomes = report.verdicts.map(({ name, lastStatus }) => [name, lastStatus]).sort();
  assert.deepEqual(outcomes, [
    ['JSON passing case', 'pass'],
    ['XML failing case', 'fail'],
  ]);

  const dashboard = 'dashboard output/packed results.html';
  cli(['html', '--out', dashboard]);
  const html = readFileSync(path.join(cwd, dashboard), 'utf8');
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /id="ff-data"/);
  for (const [name] of outcomes) assert.ok(html.includes(name), `dashboard missing ${name}`);
}

function checkLiveRetry(cwd, cli, persistent) {
  const reportFile = 'live report.xml';
  const testName = persistent ? 'persistent failure' : 'rescued on retry';
  writeFileSync(
    path.join(cwd, 'flakefinder.config.json'),
    JSON.stringify({ reports: [reportFile], runner: 'generic', minRuns: 1 }),
  );
  writeFileSync(
    path.join(cwd, 'test runner.cjs'),
    `const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const counter = 'attempt count';
const attempt = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
writeFileSync(counter, String(attempt));
const failed = ${persistent} || attempt === 1;
const failure = failed ? '<failure>failed</failure>' : '';
console.log('<testsuite name="live"><testcase name="${testName}" time="' + attempt + '">' + failure + '</testcase></testsuite>');
process.exitCode = failed ? 1 : 0;
`,
  );
  cli(
    ['run', '--retries', '1', '--', 'node', 'test runner.cjs', '>', reportFile],
    persistent ? 1 : 0,
  );
  assert.equal(readFileSync(path.join(cwd, 'attempt count'), 'utf8'), '2');
  assert.match(readFileSync(path.join(cwd, reportFile), 'utf8'), /time="2"/);
  const { verdicts } = JSON.parse(cli(['report', '--format', 'json']));
  assert.deepEqual(
    verdicts.map(({ name, classification, retryRescues, lastStatus }) => ({
      name,
      classification,
      retryRescues,
      lastStatus,
    })),
    [
      {
        name: testName,
        classification: persistent ? 'failing' : 'flaky-retry',
        retryRescues: persistent ? 0 : 1,
        lastStatus: persistent ? 'fail' : 'pass',
      },
    ],
  );
}

function main() {
  const [tarball, expected, extra] = process.argv.slice(2);
  assert.ok(
    tarball && path.isAbsolute(tarball) && /^[a-f\d]{64}$/i.test(expected) && extra === undefined,
    'usage: node scripts/packed-smoke.mjs <absolute-path-to-tgz> <expected-sha256>',
  );
  const bytes = readFileSync(tarball);
  const actual = createHash('sha256').update(bytes).digest('hex');
  assert.equal(actual, expected.toLowerCase(), `SHA-256 mismatch for ${tarball}`);

  const scratch = mkdtempSync(path.join(tmpdir(), 'flakefinder packed smoke '));
  try {
    const prefix = path.join(scratch, 'packed install');
    mkdirSync(prefix);
    // Install the exact bytes that were hashed, using only the temporary prefix.
    writeFileSync(path.join(prefix, 'package.tgz'), bytes);
    run(
      WINDOWS ? path.join(path.dirname(process.execPath), 'npm.cmd') : 'npm',
      ['--prefix', '.', 'install', '--engine-strict', '--no-audit', '--no-fund', './package.tgz'],
      prefix,
    );

    const modules = path.join(prefix, 'node_modules');
    const manifest = JSON.parse(
      readFileSync(path.join(modules, 'flakefinder', 'package.json'), 'utf8'),
    );
    assert.equal(manifest.name, 'flakefinder');
    assert.match(manifest.version, /^\d+\.\d+\.\d+/);
    const shim = path.join(modules, '.bin', WINDOWS ? 'flakefinder.cmd' : 'flakefinder');
    const project = (name, check) => {
      const cwd = path.join(scratch, name);
      mkdirSync(cwd);
      const cli = (args, status) =>
        run(WINDOWS ? path.relative(cwd, shim) : shim, args, cwd, status);
      check(cwd, cli);
    };
    project('ingest project', (cwd, cli) => {
      assert.equal(cli(['--version']).trim(), manifest.version);
      ingestAndReport(cwd, cli, manifest.version);
    });
    project('retry project', (cwd, cli) => checkLiveRetry(cwd, cli, false));
    project('failure project', (cwd, cli) => checkLiveRetry(cwd, cli, true));
    console.log(
      `Packed flakefinder ${manifest.version} passed on ${process.platform} / Node ${process.version}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

try {
  main();
} catch (error) {
  console.error(`Packed smoke failed: ${error.message}`);
  process.exitCode = 1;
}
