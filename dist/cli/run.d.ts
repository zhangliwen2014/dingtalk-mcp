export interface RpcLike {
    request(method: string, params?: unknown): Promise<any>;
}
export interface InjectionLoopOptions {
    rpc: RpcLike;
    write: (data: string) => void;
    sessionId: string;
    cwd: string;
    intervalMs?: number;
    enterDelayMs?: number;
}
export declare class InjectionLoop {
    private rpc;
    private write;
    private sessionId;
    private cwd;
    private intervalMs;
    private enterDelayMs;
    private timer;
    private stopped;
    private ticking;
    constructor(options: InjectionLoopOptions);
    start(): Promise<void>;
    stop(): void;
    private tick;
    private safeRequest;
}
export interface PtyChild {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    onData(cb: (data: string) => void): void;
    onExit(cb: (e: {
        exitCode: number;
    }) => void): void;
}
export interface Tty {
    setRawMode(mode: boolean): void;
    columns: number;
    rows: number;
    onResize(cb: () => void): void;
    write(data: string): void;
    onStdinData(cb: (data: string) => void): void;
}
export interface WrapDeps {
    spawn: (command: string, args: string | string[], opts: any) => PtyChild;
    connectRpc: (endpoint: string) => RpcLike;
    tty: Tty;
    endpoint: string;
    env: NodeJS.ProcessEnv;
    onSignal?: (signal: string, cb: () => void) => void;
    pollIntervalMs?: number;
    warmupMs?: number;
}
export declare function resolveLaunch(argv: string[], defaultCommand: string): {
    command: string;
    args: string[];
};
export interface WindowsResolveOptions {
    pathEnv?: string;
    cwd?: string;
    comspec?: string;
    exists?: (path: string) => boolean;
}
export declare function resolveWindowsLaunch(command: string, args: string[], opts?: WindowsResolveOptions): {
    command: string;
    args: string | string[];
};
export declare function runWrapped(deps: WrapDeps, command: string, args: string | string[]): Promise<number>;
export declare function runCommand(argv: string[]): Promise<void>;
//# sourceMappingURL=run.d.ts.map