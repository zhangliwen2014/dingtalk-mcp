import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function packageVersion(): string {
  const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
  if (!pkg.version) throw new Error(`missing version in ${pkgPath}`);
  return pkg.version;
}
