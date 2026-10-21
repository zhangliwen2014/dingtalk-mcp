import { encodeTerminalInput } from '../core/injector.js';
import * as identity from '../platform/identity.js';
import * as ipc from '../platform/ipc.js';
import { IpcClient } from '../daemon/client.js';
import { randomUUID } from 'node:crypto';

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

export class InjectionLoop {
  private rpc: RpcLike;
  private write: (data: string) => void;
  private sessionId: string;
  private cwd: string;
  private intervalMs: number;
  private enterDelayMs: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private ticking = false;

  constructor(options: InjectionLoopOptions) {
    this.rpc = options.rpc;
    this.write = options.write;
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.intervalMs = options.intervalMs ?? 2000;
    this.enterDelayMs = options.enterDelayMs ?? 300;
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    await this.safeRequest('hook_ping', { session_id: this.sessionId, cwd: this.cwd });
    // Register the wrapped project so a DingTalk group exists (and is polled)
    // even if the agent never asks a question through the MCP tools.
    await this.safeRequest('hook_register', { cwd: this.cwd });
    if (this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    void this.safeRequest('hook_leave', { session_id: this.sessionId });
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.safeRequest('hook_ping', { session_id: this.sessionId, cwd: this.cwd });
      const res = await this.safeRequest('hook_poll', { cwd: this.cwd });
      if (this.stopped) return;
      const messages = (res?.messages ?? []) as Array<{
        id: number;
        content: string;
      }>;

      const delivered: number[] = [];
      let failedFrom = -1;
      for (let i = 0; i < messages.length; i++) {
        if (this.stopped) return;
        const msg = messages[i];
        const payload = encodeTerminalInput(msg.content);
        try {
          // The Enter must arrive as its own stdin event; coalesced into the paste
          // chunk the TUI treats it as part of the paste and never submits.
          this.write(payload.slice(0, -1));
          await new Promise((r) => setTimeout(r, this.enterDelayMs));
          if (this.stopped) return;
          this.write('\r');
          delivered.push(msg.id);
        } catch {
          // pty died mid-batch: this message and the rest go back to the pool.
          failedFrom = i;
          break;
        }
      }

      if (delivered.length > 0) {
        await this.safeRequest('hook_ack', { cwd: this.cwd, ids: delivered });
      }
      if (failedFrom >= 0) {
        const rest = messages.slice(failedFrom).map((m) => m.id);
        await this.safeRequest('hook_unclaim', { cwd: this.cwd, ids: rest });
      }
    } finally {
      this.ticking = false;
    }
  }

  private async safeRequest(method: string, params: unknown): Promise<any> {
    try {
      return await this.rpc.request(method, params);
    } catch {
      return null;
    }
  }
}

export interface PtyChild {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
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
  spawn: (command: string, args: string[], opts: any) => PtyChild;
  connectRpc: (endpoint: string) => RpcLike;
  tty: Tty;
  endpoint: string;
  env: NodeJS.ProcessEnv;
  onSignal?: (signal: string, cb: () => void) => void;
  pollIntervalMs?: number;
  warmupMs?: number;
}

export function resolveLaunch(
  argv: string[],
  defaultCommand: string
): { command: string; args: string[] } {
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    return { command: argv[0], args: argv.slice(1) };
  }
  return { command: defaultCommand, args: [...argv] };
}

// Runs `command` inside a PTY, transparently proxying the real terminal,
// while injecting any pending phone messages as if a human had typed them.
// Resolves with the child's exit code.
export function runWrapped(deps: WrapDeps, command: string, args: string[]): Promise<number> {
  const cwd = process.cwd();
  const sessionId = randomUUID();

  const child = deps.spawn(command, args, {
    name: deps.env.TERM || 'xterm-256color',
    cols: deps.tty.columns,
    rows: deps.tty.rows,
    cwd,
    env: { ...deps.env, DTMCP_WRAPPED: '1' },
  });

  const rpc = deps.connectRpc(deps.endpoint);
  // node-pty throws EIO once the child is gone; a dead pty must never crash the wrapper.
  const safeWrite = (d: string) => {
    try {
      child.write(d);
    } catch {
      /* child already exited */
    }
  };
  const loop = new InjectionLoop({
    rpc,
    // Raw write here: a throwing write lets the loop unclaim its lease instead
    // of acking keystrokes the dead pty never received.
    write: (d) => child.write(d),
    sessionId,
    cwd,
    intervalMs: deps.pollIntervalMs ?? 2000,
  });

  // Claim phone messages only once the inner TUI has actually painted and
  // settled, otherwise injected keystrokes would land during startup and be lost.
  let loopScheduled = false;
  const scheduleLoop = () => {
    if (loopScheduled) return;
    loopScheduled = true;
    setTimeout(() => void loop.start(), deps.warmupMs ?? 3000);
  };

  deps.tty.setRawMode(true);
  deps.tty.onStdinData(safeWrite);
  child.onData((d) => {
    scheduleLoop();
    deps.tty.write(d);
  });
  deps.tty.onResize(() => child.resize(deps.tty.columns, deps.tty.rows));

  // Losing the terminal (or being killed) must still restore the parent tty
  // and take the inner CLI down with us, otherwise it is orphaned forever.
  const onSignal = () => {
    loop.stop();
    deps.tty.setRawMode(false);
    child.kill();
  };
  deps.onSignal?.('SIGTERM', onSignal);
  deps.onSignal?.('SIGHUP', onSignal);

  return new Promise<number>((resolve) => {
    child.onExit(({ exitCode }) => {
      loop.stop();
      deps.tty.setRawMode(false);
      resolve(exitCode);
    });
  });
}

export async function runCommand(argv: string[]): Promise<void> {
  const pty = await import('node-pty');
  const endpoint = ipc.endpoint(identity.instanceId());
  const { command, args } = resolveLaunch(argv, 'qodercli');

  const tty: Tty = {
    setRawMode: (m) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(m);
    },
    get columns() {
      return process.stdout.columns || 80;
    },
    get rows() {
      return process.stdout.rows || 24;
    },
    onResize: (cb) => process.stdout.on('resize', cb),
    write: (d) => process.stdout.write(d),
    onStdinData: (cb) => {
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
      process.stdin.on('data', cb);
    },
  };

  const exitCode = await runWrapped(
    {
      spawn: (cmd, args, opts) => pty.spawn(cmd, args, opts) as unknown as PtyChild,
      connectRpc: (ep) => {
        const client = new IpcClient(ep);
        void client.connect().catch(() => {});
        return client;
      },
      tty,
      endpoint,
      env: process.env,
      onSignal: (sig, cb) => process.on(sig, cb),
    },
    command,
    args
  );

  process.exit(exitCode);
}