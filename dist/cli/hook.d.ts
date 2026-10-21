export interface HookInput {
    hook_event_name: string;
    session_id: string;
    cwd: string;
    last_assistant_message?: string;
}
export interface HookRpc {
    request(method: string, params: any): Promise<any>;
}
export declare function runHook(input: HookInput, rpc: HookRpc, env: NodeJS.ProcessEnv): Promise<string>;
//# sourceMappingURL=hook.d.ts.map