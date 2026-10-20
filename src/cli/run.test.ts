import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  InjectionLoop,
  runWrapped,
  type PtyChild,
  type RpcLike,
  type Tty,
  type WrapDeps,
} from './run.js';

const PASTE_ON = '\x1b[200~';
const PASTE_OFF = '\x1b[201~';

function makeRpc(): RpcLike & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    async request(method: string, params: unknown) {
      calls.push([method, params]);
      if (method === 'hook_poll') {
        return { ok: true, messages: [] };
      }
      return { ok: true };
    },
  };
}

describe('cli/run InjectionLoop', () => {
  let rpc: ReturnType<typeof makeRpc>;
  let written: string[];
  let loop: InjectionLoop;

  beforeEach(() => {
    vi.useFakeTimers();
    rpc = makeRpc();
    written = [];
    loop = new InjectionLoop({
      rpc,
      write: (d) => written.push(d),
      sessionId: 'wrap-1',
      cwd: '/tmp/proj',
      intervalMs: 1000,
    });
  });

  afterEach(() => {
    loop.stop();
    vi.useRealTimers();
  });

  it('registers the live session on start', async () => {
    await loop.start();
    expect(rpc.calls[0][0]).toBe('hook_ping');
    expect(rpc.calls[0][1]).toEqual({ session_id: 'wrap-1', cwd: '/tmp/proj' });
  });

  it('each tick keeps alive and pulls pending phone messages', async () => {
    await loop.start();
    rpc.calls.length = 0;

    await vi.advanceTimersByTimeAsync(1000);
    expect(rpc.calls.map((c) => c[0])).toEqual(['hook_ping', 'hook_poll']);
  });

  it('injects claimed messages into the pty as bracketed paste, then submits with a delayed Enter, in order', async () => {
    rpc.request = vi.fn(async (method: string) => {
      if (method === 'hook_poll') {
        return {
          ok: true,
          messages: [
            { id: 1, content: '第一条', senderId: 'u', timestamp: 1 },
            { id: 2, content: '第二条', senderId: 'u', timestamp: 2 },
          ],
        };
      }
      return { ok: true };
    });

    await loop.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(written).toEqual([`${PASTE_ON}第一条${PASTE_OFF}`]);
    await vi.advanceTimersByTimeAsync(400);
    expect(written).toEqual([
      `${PASTE_ON}第一条${PASTE_OFF}`,
      '\r',
      `${PASTE_ON}第二条${PASTE_OFF}`,
    ]);
    await vi.advanceTimersByTimeAsync(400);
    expect(written).toEqual([
      `${PASTE_ON}第一条${PASTE_OFF}`,
      '\r',
      `${PASTE_ON}第二条${PASTE_OFF}`,
      '\r',
    ]);
  });

  it('survives daemon failures and keeps ticking', async () => {
    const original = rpc.request.bind(rpc);
    let tick = 0;
    rpc.request = async (method: string, params: unknown) => {
      tick++;
      if (tick === 2) throw new Error('boom');
      return original(method, params);
    };

    await loop.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it('stops cleanly: no more ticks and a leave call', async () => {
    await loop.start();
    rpc.calls.length = 0;
    loop.stop();

    expect(rpc.calls.map((c) => c[0])).toContain('hook_leave');
    await vi.advanceTimersByTimeAsync(5000);
    expect(rpc.calls.filter((c) => c[0] === 'hook_poll')).toHaveLength(0);
  });

  it('does not leave twice', async () => {
    await loop.start();
    loop.stop();
    loop.stop();
    expect(rpc.calls.filter((c) => c[0] === 'hook_leave')).toHaveLength(1);
  });
});

interface FakeChild extends PtyChild {
  writes: string[];
  resizes: Array<[number, number]>;
  onDataCb: ((d: string) => void) | null;
  onExitCb: ((e: { exitCode: number }) => void) | null;
  fireData(d: string): void;
  fireExit(code: number): void;
}

function makeChild(): FakeChild {
  return {
    writes: [],
    resizes: [],
    onDataCb: null,
    onExitCb: null,
    write(d: string) {
      this.writes.push(d);
    },
    resize(cols: number, rows: number) {
      this.resizes.push([cols, rows]);
    },
    kill() {},
    onData(cb) {
      this.onDataCb = cb;
    },
    onExit(cb) {
      this.onExitCb = cb;
    },
    fireData(d: string) {
      this.onDataCb?.(d);
    },
    fireExit(code: number) {
      this.onExitCb?.({ exitCode: code });
    },
  };
}

function makeTty() {
  const out: string[] = [];
  const rawModes: boolean[] = [];
  let stdinCb: ((d: string) => void) | null = null;
  let resizeCb: (() => void) | null = null;
  const tty: Tty = {
    setRawMode(m: boolean) {
      rawModes.push(m);
    },
    columns: 120,
    rows: 40,
    onResize(cb: () => void) {
      resizeCb = cb;
    },
    write(d: string) {
      out.push(d);
    },
    onStdinData(cb: (d: string) => void) {
      stdinCb = cb;
    },
  };
  return {
    tty,
    out,
    rawModes,
    sendStdin(d: string) {
      stdinCb?.(d);
    },
    fireResize() {
      resizeCb?.();
    },
  };
}

describe('cli/run runWrapped', () => {
  it('does not claim messages until the child TUI has rendered and warmup elapsed', async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      const t = makeTty();
      const rpc = makeRpc();
      const deps: WrapDeps = {
        spawn: () => child,
        connectRpc: () => rpc,
        tty: t.tty,
        endpoint: 'e',
        env: {},
        pollIntervalMs: 1000,
        warmupMs: 500,
      };

      const p = runWrapped(deps, 'qodercli', []);
      await vi.advanceTimersByTimeAsync(3000);
      expect(rpc.calls).toHaveLength(0);

      child.fireData('banner');
      await vi.advanceTimersByTimeAsync(499);
      expect(rpc.calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(rpc.calls[0]?.[0]).toBe('hook_ping');

      child.fireData('more');
      await vi.advanceTimersByTimeAsync(5000);
      const pingStarts = rpc.calls.filter((c) => c[0] === 'hook_ping').length;
      expect(pingStarts).toBe(6);

      child.fireExit(0);
      await p;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stopped loop never starts after warmup fires', async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      const t = makeTty();
      const rpc = makeRpc();
      const deps: WrapDeps = {
        spawn: () => child,
        connectRpc: () => rpc,
        tty: t.tty,
        endpoint: 'e',
        env: {},
        pollIntervalMs: 1000,
        warmupMs: 500,
      };

      const p = runWrapped(deps, 'qodercli', []);
      child.fireData('banner');
      child.fireExit(2);
      await p;
      await vi.advanceTimersByTimeAsync(10000);
      expect(rpc.calls.filter((c) => c[0] === 'hook_ping')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('spawns with DTMCP_WRAPPED and terminal geometry', async () => {
    const child = makeChild();
    const { tty, out } = makeTty();
    const spawnOpts: any[] = [];
    const rpc = makeRpc();
    const deps: WrapDeps = {
      spawn: (_c, _a, opts) => {
        spawnOpts.push(opts);
        return child;
      },
      connectRpc: () => rpc,
      tty,
      endpoint: 'ipc://test',
      env: { TERM: 'xterm-256color', HOME: '/Users/x' },
      pollIntervalMs: 1000,
      warmupMs: 1,
    };

    const p = runWrapped(deps, 'qodercli', ['--resume', 'abc']);
    child.fireExit(0);
    await p;

    expect(spawnOpts[0].name).toBe('xterm-256color');
    expect(spawnOpts[0].cols).toBe(120);
    expect(spawnOpts[0].rows).toBe(40);
    expect(spawnOpts[0].cwd).toBe(process.cwd());
    expect(spawnOpts[0].env.DTMCP_WRAPPED).toBe('1');
    expect(spawnOpts[0].env.HOME).toBe('/Users/x');
    expect(out).toEqual([]);
  });

  it('proxies stdin to the pty and pty output to the tty', async () => {
    const child = makeChild();
    const t = makeTty();
    const rpc = makeRpc();
    const deps: WrapDeps = {
      spawn: () => child,
      connectRpc: () => rpc,
      tty: t.tty,
      endpoint: 'e',
      env: {},
      pollIntervalMs: 1000,
    };

    const p = runWrapped(deps, 'qodercli', []);
    t.sendStdin('hello');
    child.fireData('\x1b[2Jready');
    child.fireExit(0);
    await p;

    expect(child.writes).toContain('hello');
    expect(t.out).toContain('\x1b[2Jready');
  });

  it('forwards resizes with current tty geometry', async () => {
    const child = makeChild();
    const t = makeTty();
    const deps: WrapDeps = {
      spawn: () => child,
      connectRpc: () => makeRpc(),
      tty: t.tty,
      endpoint: 'e',
      env: {},
      pollIntervalMs: 1000,
    };

    const p = runWrapped(deps, 'qodercli', []);
    t.fireResize();
    child.fireExit(0);
    await p;

    expect(child.resizes).toEqual([[120, 40]]);
  });

  it('on exit: stops the loop, restores raw mode, resolves exit code', async () => {
    const child = makeChild();
    const t = makeTty();
    const rpc = makeRpc();
    const deps: WrapDeps = {
      spawn: () => child,
      connectRpc: () => rpc,
      tty: t.tty,
      endpoint: 'e',
      env: {},
      pollIntervalMs: 1000,
    };

    const p = runWrapped(deps, 'qodercli', []);
    child.fireExit(7);
    expect(await p).toBe(7);

    expect(rpc.calls.map((c) => c[0])).toContain('hook_leave');
    expect(t.rawModes).toEqual([true, false]);

    const before = rpc.calls.length;
    await vi.waitFor(() => expect(rpc.calls.length).toBe(before));
  });
});
