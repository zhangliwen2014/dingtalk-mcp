import * as paths from './paths.js';

export function endpoint(instanceId: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\dtmcp-${instanceId}`;
  }
  return paths.ipcEndpoint().replace('dtmcp.sock', `dtmcp-${instanceId}.sock`);
}
