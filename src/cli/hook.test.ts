import { describe, it, expect, vi } from 'vitest';
import { runHook, type HookInput } from './hook.js';

function makeRpc(result?: Partial<Record<string, any>>) {
  return {
    request: vi.fn(async (method: string) => {
      const v = result?.[method];
      if (typeof v === 'function') return v();
      return v ?? { ok: true };
    }),
  };
}

const base: HookInput = {
  hook_event_name: 'PostToolUse',
  session_id: 's1',
  cwd: '/repo/p1',
};

describe('cli/hook runHook', () => {
  it('short-circuits everything in headless mode', async () => {
    const rpc = makeRpc();
    const out = await runHook(base, rpc, { DTMCP_HEADLESS: '1' });

    expect(out).toBe('');
    expect(rpc.request).not.toHaveBeenCalled();
  });

  it('under a dtmcp-run wrapper, boundary hooks keep alive but never claim (no double injection)', async () => {
    const rpc = makeRpc();
    const out = await runHook(base, rpc, { DTMCP_WRAPPED: '1' });

    expect(out).toBe('');
    expect(rpc.request).toHaveBeenCalledWith('hook_ping', {
      session_id: 's1',
      cwd: '/repo/p1',
    });
    expect(rpc.request).not.toHaveBeenCalledWith('hook_poll', expect.anything());
  });

  it('under a dtmcp-run wrapper, Stop still mirrors the final reply to the phone', async () => {
    const rpc = makeRpc();
    await runHook(
      { ...base, hook_event_name: 'Stop', last_assistant_message: '已完成' },
      rpc,
      { DTMCP_WRAPPED: '1' }
    );

    expect(rpc.request).toHaveBeenCalledWith('hook_mirror', {
      cwd: '/repo/p1',
      content: '已完成',
    });
  });

  it('SessionStart pings the daemon', async () => {
    const rpc = makeRpc();
    await runHook({ ...base, hook_event_name: 'SessionStart' }, rpc, {});

    expect(rpc.request).toHaveBeenCalledWith('hook_ping', {
      session_id: 's1',
      cwd: '/repo/p1',
    });
  });

  it('SessionEnd leaves the registry', async () => {
    const rpc = makeRpc();
    await runHook({ ...base, hook_event_name: 'SessionEnd' }, rpc, {});

    expect(rpc.request).toHaveBeenCalledWith('hook_leave', {
      session_id: 's1',
    });
  });

  it('PostToolUse refreshes activity and claims phone messages into additionalContext', async () => {
    const rpc = makeRpc({
      hook_poll: {
        ok: true,
        projectId: 'p1',
        messages: [
          { id: 1, content: '进展如何', senderId: 'u1', timestamp: 100 },
        ],
      },
    });

    const out = await runHook(base, rpc, {});
    const parsed = JSON.parse(out);

    expect(rpc.request).toHaveBeenCalledWith('hook_ping', {
      session_id: 's1',
      cwd: '/repo/p1',
    });
    expect(rpc.request).toHaveBeenCalledWith('hook_poll', { cwd: '/repo/p1' });
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('进展如何');
  });

  it('PostToolUse with no pending messages outputs nothing', async () => {
    const rpc = makeRpc({ hook_poll: { ok: true, messages: [] } });
    const out = await runHook(base, rpc, {});

    expect(out).toBe('');
  });

  it('PostToolUse acks delivered message ids', async () => {
    const rpc = makeRpc({
      hook_poll: {
        ok: true,
        messages: [
          { id: 1, content: 'A', senderId: 'u1', timestamp: 100 },
          { id: 4, content: 'B', senderId: 'u1', timestamp: 101 },
        ],
      },
    });

    await runHook(base, rpc, {});

    expect(rpc.request).toHaveBeenCalledWith('hook_ack', {
      cwd: '/repo/p1',
      ids: [1, 4],
    });
  });

  it('a hook_ack failure still delivers the context (lease reclaims later)', async () => {
    const rpc = makeRpc({
      hook_poll: {
        ok: true,
        messages: [{ id: 1, content: 'A', senderId: 'u1', timestamp: 100 }],
      },
      hook_ack: () => {
        throw new Error('daemon gone');
      },
    });

    const out = await runHook(base, rpc, {});
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain('A');
  });

  it('UserPromptSubmit polls as well', async () => {
    const rpc = makeRpc({
      hook_poll: {
        ok: true,
        messages: [{ id: 2, content: '继续', senderId: 'u1', timestamp: 1 }],
      },
    });

    const out = await runHook(
      { ...base, hook_event_name: 'UserPromptSubmit' },
      rpc,
      {}
    );

    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain('继续');
  });

  it('Stop mirrors the final assistant message', async () => {
    const rpc = makeRpc();
    const out = await runHook(
      { ...base, hook_event_name: 'Stop', last_assistant_message: '任务完成了 80%' },
      rpc,
      {}
    );

    expect(rpc.request).toHaveBeenCalledWith('hook_mirror', {
      cwd: '/repo/p1',
      content: '任务完成了 80%',
    });
    expect(out).toBe('');
  });

  it('Stop with empty message does not mirror', async () => {
    const rpc = makeRpc();
    await runHook(
      { ...base, hook_event_name: 'Stop', last_assistant_message: '   ' },
      rpc,
      {}
    );

    expect(rpc.request).not.toHaveBeenCalledWith(
      'hook_mirror',
      expect.anything()
    );
  });

  it('unknown events are no-ops', async () => {
    const rpc = makeRpc();
    const out = await runHook({ ...base, hook_event_name: 'PreCompact' }, rpc, {});

    expect(out).toBe('');
    expect(rpc.request).not.toHaveBeenCalled();
  });
});
