export interface SessionRegistryOptions {
    staleMs?: number;
}
export declare class SessionRegistry {
    private sessions;
    private staleMs;
    constructor(options?: SessionRegistryOptions);
    ping(sessionId: string, cwd: string): void;
    leave(sessionId: string): void;
    isActive(cwd: string): boolean;
}
//# sourceMappingURL=session-registry.d.ts.map