import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as paths from './paths.js';

export function instanceId(): string {
  const username = os.userInfo().username || process.env.USER || process.env.USERNAME || 'unknown';
  const configHash = crypto.createHash('sha256').update(paths.home()).digest('hex').slice(0, 8);
  return `${username}-${configHash}`;
}
