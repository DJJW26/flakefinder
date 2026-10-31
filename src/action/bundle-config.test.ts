import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

describe('action bundle configuration', () => {
  it('bundles every dependency: a checked-out action has no node_modules', () => {
    // tsup externalizes package.json `dependencies` by default; the action
    // bundle then threw "Cannot find module 'fast-xml-parser'" on runners
    const cfg = readFileSync(path.join(root, 'tsup.config.ts'), 'utf8');
    const actionBlock = cfg.slice(cfg.indexOf("'action/index'"));
    expect(actionBlock).toMatch(/noExternal:\s*\[\/\.\*\/\]/);
    expect(actionBlock).toMatch(/target:\s*'node24'/);
  });

  it('action.yml runs the bundle on node24 (QA ACT-7)', () => {
    const yml = readFileSync(path.join(root, 'action.yml'), 'utf8');
    expect(yml).toMatch(/using:\s*node24/);
    expect(yml).toMatch(/main:\s*dist\/action\/index\.cjs/);
  });
});
