import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRunner } from './agent-runner.js';
import type { RunnerProject } from './agent-runner.js';
import * as cp from 'child_process';

vi.mock('child_process');

interface FakeChild {
  stdout: { on: (event: string, cb: (data: string) => void) => void };
  stderr: { on: (event: string, cb: (data: string) => void) => void };
  on: (event: string, cb: (code: number) => void) => void;
  kill: ReturnType<typeof vi.fn>;
  emitStdout: (data: string) => void;
  emitClose: (code: number) => void;
}

function makeFakeChild(): FakeChild {
  const stdoutHandlers: Array<(data: string) => void> = [];
  const stderrHandlers: Array<(data: string) => void> = [];
  const closeHandlers: Array<(code: number) => void> = [];
  return {
    stdout: {
      on: (_e, cb) => stdoutHandlers.push(cb),
    },
    stderr: {
      on: (_e, cb) => stderrHandlers.push(cb),
    },
    on: (_e, cb) => closeHandlers.push(cb),
    kill: vi.fn(),
    emitStdout: (data) => stdoutHandlers.forEach((h) => h(data)),
    emitClose: (code) => closeHandlers.forEach((h) => h(code)),
  };
}

function resultJson(result: string, isError = false): string {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: isError, result });
}

const project: RunnerProject = {
  projectId: 'p1',
  projectTitle: '测试项目',
  chatId: 'cid-1',
  workdir: '/tmp/p1',
};

function successPayload(text: string): string {
  return resultJson(text, false) + '\n';
}

describe('daemon/agent-runner', () => {
  let send: ReturnType<typeof vi.fn>;
  let children: FakeChild[];
  let runner: AgentRunner;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    send = vi.fn(async () => {});
    children = [];
    vi.mocked(cp.spawn).mockImplementation(() => {
      const child = makeFakeChild();
      children.push(child);
      return child as never;
    });
    runner = new AgentRunner({
      send,
      ackDelayMs: 15_000,
      timeoutMs: 900_000,
      maxLen: 100,
    });
  });

  afterEach(() => {
    runner.stop();
    vi.useRealTimers();
  });

  it('sends only the final result when the run completes quickly', async () => {
    runner.enqueue(project, '现在进展如何');

    expect(cp.spawn).toHaveBeenCalledTimes(1);
    const args = vi.mocked(cp.spawn).mock.calls[0][1] as string[];
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('-w');
    expect(args).toContain('/tmp/p1');
    expect(args[args.length - 1]).toBe('现在进展如何');

    children[0].emitStdout(successPayload('已完成 80%'));
    children[0].emitClose(0);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(send).toHaveBeenCalledWith('cid-1', '已完成 80%');
  });

  it('marks the spawn environment headless so hooks no-op inside the run', async () => {
    runner.enqueue(project, 'x');

    expect(cp.spawn).toHaveBeenCalledTimes(1);
    const options = vi.mocked(cp.spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(options.env.DTMCP_HEADLESS).toBe('1');
  });

  it('sends a working-soon notice only when the run exceeds ackDelayMs', async () => {
    runner.enqueue(project, '跑一下全部测试');

    vi.advanceTimersByTime(14_000);
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain('正在处理');

    children[0].emitStdout(successPayload('测试全绿'));
    children[0].emitClose(0);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
    expect(send.mock.calls[1][1]).toBe('测试全绿');
  });

  it('reports failure when result JSON marks is_error', async () => {
    runner.enqueue(project, '坏消息');
    children[0].emitStdout(resultJson('boom', true) + '\n');
    children[0].emitClose(0);

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(send.mock.calls[0][1]).toContain('处理失败');
  });

  it('reports failure when output is not parseable', async () => {
    runner.enqueue(project, '乱输出');
    children[0].emitStdout('not json at all\n');
    children[0].emitClose(1);

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(send.mock.calls[0][1]).toContain('处理失败');
  });

  it('truncates long results to maxLen with a marker', async () => {
    const long = 'x'.repeat(250);
    runner.enqueue(project, '长答复');
    children[0].emitStdout(successPayload(long));
    children[0].emitClose(0);

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    const sent = send.mock.calls[0][1] as string;
    expect(sent.length).toBeLessThanOrEqual(100 + '…'.length + 20);
    expect(sent).toContain('已截断');
  });

  it('processes queued messages serially, one spawn at a time', async () => {
    runner.enqueue(project, '第一条');
    runner.enqueue(project, '第二条');

    expect(cp.spawn).toHaveBeenCalledTimes(1);

    children[0].emitStdout(successPayload('答复一'));
    children[0].emitClose(0);
    await vi.waitFor(() => {
      expect(cp.spawn).toHaveBeenCalledTimes(2);
    });
    const secondArgs = vi.mocked(cp.spawn).mock.calls[1][1] as string[];
    expect(secondArgs[secondArgs.length - 1]).toBe('第二条');

    children[1].emitStdout(successPayload('答复二'));
    children[1].emitClose(0);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  it('kills and notifies on timeout', async () => {
    runner.enqueue(project, '卡死了');
    vi.advanceTimersByTime(900_001);

    expect(children[0].kill).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled();
    });
    const texts = send.mock.calls.map((c) => c[1] as string).join('|');
    expect(texts).toContain('超时');
  });

  it('stop kills the current run and drains the queue without sending', async () => {
    runner.enqueue(project, 'a');
    runner.enqueue(project, 'b');
    runner.stop();

    expect(children[0].kill).toHaveBeenCalled();
    children[0].emitStdout(successPayload('不会发'));
    children[0].emitClose(0);
    await vi.advanceTimersByTimeAsync(1_000_000);
    await vi.waitFor(() => {});
    expect(send).not.toHaveBeenCalled();
    expect(cp.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not send the working-soon notice after the run already finished', async () => {
    runner.enqueue(project, '快任务');
    children[0].emitStdout(successPayload('秒回'));
    children[0].emitClose(0);
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });

    vi.advanceTimersByTime(60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  describe('permission mode configuration', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmcp-cfg-'));
    });

    it('defaults to full (dangerously-skip-permissions)', () => {
      const r = new AgentRunner({ send, configDir: tempDir });
      expect(r.getPermissionMode()).toBe('full');

      r.enqueue(project, 'x');
      const args = vi.mocked(cp.spawn).mock.calls[0][1] as string[];
      expect(args).toContain('--dangerously-skip-permissions');
      r.stop();
    });

    it('reads agent.permissionMode from config.json', () => {
      fs.writeFileSync(
        path.join(tempDir, 'config.json'),
        JSON.stringify({ agent: { permissionMode: 'read-only' } })
      );

      const r = new AgentRunner({ send, configDir: tempDir });
      expect(r.getPermissionMode()).toBe('read-only');

      r.enqueue(project, 'x');
      const args = vi.mocked(cp.spawn).mock.calls[0][1] as string[];
      expect(args).toContain('--tools');
      expect(args).not.toContain('--dangerously-skip-permissions');
      r.stop();
    });

    it('env var overrides config.json', () => {
      fs.writeFileSync(
        path.join(tempDir, 'config.json'),
        JSON.stringify({ agent: { permissionMode: 'read-only' } })
      );
      process.env.DTMCP_AGENT_PERMISSION_MODE = 'accept-edits';

      const r = new AgentRunner({ send, configDir: tempDir });
      expect(r.getPermissionMode()).toBe('accept-edits');
      r.stop();
      delete process.env.DTMCP_AGENT_PERMISSION_MODE;
    });

    it('constructor option overrides everything', () => {
      process.env.DTMCP_AGENT_PERMISSION_MODE = 'read-only';
      const r = new AgentRunner({
        send,
        configDir: tempDir,
        permissionMode: 'full',
      });
      expect(r.getPermissionMode()).toBe('full');
      r.stop();
      delete process.env.DTMCP_AGENT_PERMISSION_MODE;
    });
  });
});
