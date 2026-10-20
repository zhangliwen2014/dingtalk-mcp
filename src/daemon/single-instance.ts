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
      fs.writeFileSync(path.join(this.lockDir, 'pid'), String(process.pid));
      return true;
    } catch {
      return this.reclaimStaleLock();
    }
  }

  private reclaimStaleLock(): boolean {
    let pid: number | null = null;
    try {
      pid = parseInt(fs.readFileSync(path.join(this.lockDir, 'pid'), 'utf8'), 10);
    } catch {
      // No pid file — a lock left by a pre-PID version; treat as stale.
    }

    if (pid !== null && Number.isFinite(pid) && isProcessAlive(pid)) {
      return false;
    }

    try {
      fs.rmSync(this.lockDir, { recursive: true, force: true });
      fs.mkdirSync(this.lockDir);
      this.acquired = true;
      fs.writeFileSync(path.join(this.lockDir, 'pid'), String(process.pid));
      return true;
    } catch {
      return false;
    }
  }

  async release(): Promise<void> {
    if (this.acquired) {
      try {
        fs.rmSync(this.lockDir, { recursive: true, force: true });
        this.acquired = false;
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
