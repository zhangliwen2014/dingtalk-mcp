import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export function packageVersion() {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (!pkg.version)
        throw new Error(`missing version in ${pkgPath}`);
    return pkg.version;
}
//# sourceMappingURL=version.js.map