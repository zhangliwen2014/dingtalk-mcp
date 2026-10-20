export interface HookInput {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  last_assistant_message?: string;
}

export interface HookRpc {
  request(method: string, params: any): Promise<any>;
}

export async function runHook(
  input: HookInput,
  rpc: HookRpc,
  env: NodeJS.ProcessEnv
): Promise<string> {
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
      const poll = await rpc.request('hook_poll', { cwd: input.cwd });
      const messages = poll?.messages ?? [];
      if (messages.length === 0) {
        return '';
      }
      const lines = messages
        .map(
          (m: any) =>
            `-（${new Date(m.timestamp).toLocaleTimeString('zh-CN')}，来自${m.senderId}）${m.content}`
        )
        .join('\n');
      const additionalContext =
        `手机钉钉发来新消息（用户远程发出，与本机输入同等对待），请逐条处理，并在最终回复中说明结果（最终回复会自动转发到手机）：\n${lines}`;
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
