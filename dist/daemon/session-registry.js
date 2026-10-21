import * as paths from '../platform/paths.js';
const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;
export class SessionRegistry {
    sessions = new Map();
    staleMs;
    constructor(options) {
        this.staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
    }
    ping(sessionId, cwd) {
        this.sessions.set(sessionId, { cwd, lastSeen: Date.now() });
    }
    leave(sessionId) {
        this.sessions.delete(sessionId);
    }
    isActive(cwd) {
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
//# sourceMappingURL=session-registry.js.map