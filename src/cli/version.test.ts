import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packageVersion } from './version.js';

describe('cli/version', () => {
  it('reports the version declared in package.json', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
    ) as { version: string };
    expect(packageVersion()).toBe(pkg.version);
  });
});
