import * as paths from '../platform/paths.js';

interface LiveSession {
  cwd: string;
  lastSeen: number;
}

export interface SessionRegistryOptions {
  staleMs?: number;
}

const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

export class SessionRegistry {
  private sessions: Map<string, LiveSession> = new Map();
  private staleMs: number;

  constructor(options?: SessionRegistryOptions) {
    this.staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  }

  ping(sessionId: string, cwd: string): void {
    this.sessions.set(sessionId, { cwd, lastSeen: Date.now() });
  }

  leave(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  isActive(cwd: string): boolean {
    const now = Date.now();
    const target = paths.resolveDir(cwd);
    for (const [id, session] of this.sessions) {
      if (paths.resolveDir(session.cwd) !== target) {
        continue;
      }
      if (now - session.lastSeen > this.staleMs) {
        this.sessions.delete(id);
        continue;
      }
      return true;
    }
    return false;
  }
}
