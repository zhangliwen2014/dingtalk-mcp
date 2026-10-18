import * as os from 'node:os';
import * as path from 'node:path';

export function home(): string {
  if (process.env.DTMCP_HOME) {
    return process.env.DTMCP_HOME;
  }
  
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'dtmcp');
  }
  
  return path.join(os.homedir(), '.dtmcp');
}

export function state(): string {
  return path.join(home(), 'state.json');
}

export function log(): string {
  return path.join(home(), 'daemon.log');
}

export function ipcEndpoint(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\dtmcp-${process.pid}`;
  }
  return path.join(home(), 'dtmcp.sock');
}
