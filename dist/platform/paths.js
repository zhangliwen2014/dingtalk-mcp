import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
export function home() {
    if (process.env.DTMCP_HOME) {
        return process.env.DTMCP_HOME;
    }
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'dtmcp');
    }
    return path.join(os.homedir(), '.dtmcp');
}
export function state() {
    return path.join(home(), 'state.json');
}
export function log() {
    return path.join(home(), 'daemon.log');
}
export function ipcEndpoint() {
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\dtmcp-${process.pid}`;
    }
    return path.join(home(), 'dtmcp.sock');
}
export function resolveDir(dir) {
    try {
        return fs.realpathSync(dir);
    }
    catch {
        return dir;
    }
}
//# sourceMappingURL=paths.js.map