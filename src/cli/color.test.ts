import { describe, expect, it } from 'vitest';
import { shouldColor } from './color.js';

describe('shouldColor (QA CLI-13/CLI-14)', () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };

  it('colors a TTY by default', () => {
    expect(shouldColor(true, tty, {})).toBe(true);
  });

  it('never colors a pipe/file', () => {
    expect(shouldColor(true, pipe, {})).toBe(false);
    expect(shouldColor(true, {}, {})).toBe(false);
  });

  it('--no-color wins even on a TTY', () => {
    expect(shouldColor(false, tty, {})).toBe(false);
  });

  it('NO_COLOR (any non-empty value) disables color on a TTY', () => {
    expect(shouldColor(true, tty, { NO_COLOR: '1' })).toBe(false);
    expect(shouldColor(true, tty, { NO_COLOR: 'false' })).toBe(false);
  });

  it('an empty NO_COLOR is ignored, per no-color.org', () => {
    expect(shouldColor(true, tty, { NO_COLOR: '' })).toBe(true);
  });
});
