import * as fs from 'node:fs';
import * as path from 'node:path';
import * as paths from '../platform/paths.js';

export class SingleInstance {
  private lockDir: string;
  private acquired = false;

  constructor(instanceId: string) {
    this.lockDir = path.join(paths.home(), `.lock-${instanceId}`);
  }

  async tryAcquire(): Promise<boolean> {
    try {
      const dir = path.dirname(this.lockDir);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      fs.mkdirSync(this.lockDir);
      this.acquired = true;
      return true;
    } catch {
      return false;
    }
  }

  async release(): Promise<void> {
    if (this.acquired) {
      try {
        fs.rmdirSync(this.lockDir);
        this.acquired = false;
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
