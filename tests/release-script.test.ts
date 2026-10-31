import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface ReleaseLib {
  insertChangelogStub(changelog: string, version: string): string;
  bumpLockfile(lockText: string, version: string): string;
}

let lib: ReleaseLib;
beforeAll(async () => {
  const script = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'release.mjs',
  );
  // importing must not run a release (main is guarded)
  lib = (await import(pathToFileURL(script).href)) as ReleaseLib;
});

describe('scripts/release.mjs (R5 #15)', () => {
  it('inserts the new stub BELOW the # Changelog title, above the newest entry', () => {
    const before = '# Changelog\n\n## 1.1.1\n\n- fixes\n';
    const after = lib.insertChangelogStub(before, '1.2.0');
    expect(after.startsWith('# Changelog\n\n## 1.2.0\n\n- _(fill in')).toBe(true);
    expect(after.indexOf('## 1.2.0')).toBeLessThan(after.indexOf('## 1.1.1'));
    expect(after.endsWith('## 1.1.1\n\n- fixes\n')).toBe(true);
  });

  it('handles a title with no blank line after it, and files without a title', () => {
    expect(lib.insertChangelogStub('# Changelog\n## 1.0.0\n', '1.0.1')).toMatch(
      /^# Changelog\n\n## 1\.0\.1\n\n- .*\n\n## 1\.0\.0\n$/,
    );
    expect(lib.insertChangelogStub('## 1.0.0\n', '1.0.1')).toMatch(
      /^## 1\.0\.1\n\n- .*\n\n## 1\.0\.0\n$/,
    );
  });

  it('does not add a second stub when the version already has a section', () => {
    const c = '# Changelog\n\n## 1.2.0\n\n- done\n\n## 1.1.1\n';
    expect(lib.insertChangelogStub(c, '1.2.0')).toBe(c);
    // 1.2.0 is not mistaken for 1.2.0-rc.1 (or vice versa)
    expect(lib.insertChangelogStub(c, '1.2.0-rc.1')).toContain('## 1.2.0-rc.1\n');
  });

  it('bumps both root versions in package-lock.json and leaves dependencies alone', () => {
    const lock = JSON.stringify(
      {
        name: 'flakefinder',
        version: '1.1.1',
        lockfileVersion: 3,
        packages: {
          '': { name: 'flakefinder', version: '1.1.1' },
          'node_modules/x': { version: '1.1.1' },
        },
      },
      null,
      2,
    );
    const out = JSON.parse(lib.bumpLockfile(lock, '1.2.0'));
    expect(out.version).toBe('1.2.0');
    expect(out.packages[''].version).toBe('1.2.0');
    expect(out.packages['node_modules/x'].version).toBe('1.1.1');
    expect(lib.bumpLockfile(lock, '1.2.0').endsWith('}\n')).toBe(true);
  });
});
