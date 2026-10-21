export declare class SingleInstance {
    private lockDir;
    private acquired;
    constructor(instanceId: string);
    tryAcquire(): Promise<boolean>;
    private reclaimStaleLock;
    release(): Promise<void>;
}
//# sourceMappingURL=single-instance.d.ts.map