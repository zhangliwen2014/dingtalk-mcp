export async function runHook(input, rpc, env) {
    if (env.DTMCP_HEADLESS) {
        return '';
    }
    switch (input.hook_event_name) {
        case 'SessionStart': {
            await rpc.request('hook_ping', {
                session_id: input.session_id,
                cwd: input.cwd,
            });
            return '';
        }
        case 'PostToolUse':
        case 'UserPromptSubmit': {
            await rpc.request('hook_ping', {
                session_id: input.session_id,
                cwd: input.cwd,
            });
            if (env.DTMCP_WRAPPED) {
                return '';
            }
            const poll = await rpc.request('hook_poll', { cwd: input.cwd });
            const messages = poll?.messages ?? [];
            if (messages.length === 0) {
                return '';
            }
            const lines = messages
                .map((m) => `-（${new Date(m.timestamp).toLocaleTimeString('zh-CN')}，来自${m.senderId}）${m.content}`)
                .join('\n');
            const additionalContext = `手机钉钉发来新消息（用户远程发出，与本机输入同等对待），请逐条处理，并在最终回复中说明结果（最终回复会自动转发到手机）：\n${lines}`;
            try {
                await rpc.request('hook_ack', {
                    cwd: input.cwd,
                    ids: messages.map((m) => m.id),
                });
            }
            catch {
                // Best effort: if the ack is lost the 60s lease returns the messages
                // to the pool instead of dropping them.
            }
            return JSON.stringify({
                hookSpecificOutput: {
                    hookEventName: input.hook_event_name,
                    additionalContext,
                },
            });
        }
        case 'SessionEnd': {
            await rpc.request('hook_leave', { session_id: input.session_id });
            return '';
        }
        case 'Stop': {
            const content = (input.last_assistant_message || '').trim();
            if (content) {
                await rpc.request('hook_mirror', { cwd: input.cwd, content });
            }
            return '';
        }
        default:
            return '';
    }
}
//# sourceMappingURL=hook.js.map