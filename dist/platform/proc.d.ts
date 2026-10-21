export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}
export declare function run(args: string[]): Promise<RunResult>;
export declare function spawnDetached(args: string[]): void;
//# sourceMappingURL=proc.d.ts.map