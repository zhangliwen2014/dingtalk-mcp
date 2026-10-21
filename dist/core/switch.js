import * as fs from 'node:fs';
import * as path from 'node:path';
import * as paths from '../platform/paths.js';
const SWITCH_FILE = 'switch.json';
export class Switch {
    filePath;
    constructor(configDir) {
        this.filePath = path.join(configDir || paths.home(), SWITCH_FILE);
    }
    async get() {
        try {
            const data = fs.readFileSync(this.filePath, 'utf8');
            const state = JSON.parse(data);
            return state.enabled !== false;
        }
        catch {
            return true;
        }
    }
    async set(enabled) {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        fs.writeFileSync(this.filePath, JSON.stringify({ enabled }, null, 2), {
            mode: 0o600
        });
    }
}
//# sourceMappingURL=switch.js.map