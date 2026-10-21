export declare const DTMCP_HOOK_COMMAND = "dtmcp hook";
type HooksObject = Record<string, unknown>;
export declare function mergeHooks(existing: HooksObject, command?: string): HooksObject;
export declare function installHooksFile(settingsPath: string, command?: string): void;
export {};
//# sourceMappingURL=install-hooks.d.ts.map