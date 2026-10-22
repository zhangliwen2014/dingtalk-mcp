import { statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { encodeTerminalInput } from '../core/injector.js';
import * as identity from '../platform/identity.js';
import * as ipc from '../platform/ipc.js';
import { IpcClient } from '../daemon/client.js';
import { randomUUID } from 'node:crypto';
export class InjectionLoop {
    rpc;
    write;
    sessionId;
    cwd;
    intervalMs;
    enterDelayMs;
    timer = null;
    stopped = false;
    ticking = false;
    constructor(options) {
        this.rpc = options.rpc;
        this.write = options.write;
        this.sessionId = options.sessionId;
        this.cwd = options.cwd;
        this.intervalMs = options.intervalMs ?? 2000;
        this.enterDelayMs = options.enterDelayMs ?? 300;
    }
    async start() {
        if (this.stopped)
            return;
        await this.safeRequest('hook_ping', { session_id: this.sessionId, cwd: this.cwd });
        // Register the wrapped project so a DingTalk group exists (and is polled)
        // even if the agent never asks a question through the MCP tools.
        await this.safeRequest('hook_register', { cwd: this.cwd });
        if (this.stopped)
            return;
        this.timer = setInterval(() => void this.tick(), this.intervalMs);
    }
    stop() {
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
    async tick() {
        if (this.ticking || this.stopped)
            return;
        this.ticking = true;
        try {
            await this.safeRequest('hook_ping', { session_id: this.sessionId, cwd: this.cwd });
            const res = await this.safeRequest('hook_poll', { cwd: this.cwd });
            if (this.stopped)
                return;
            const messages = (res?.messages ?? []);
            const delivered = [];
            let failedFrom = -1;
            for (let i = 0; i < messages.length; i++) {
                if (this.stopped)
                    return;
                const msg = messages[i];
                const payload = encodeTerminalInput(msg.content);
                try {
                    // The Enter must arrive as its own stdin event; coalesced into the paste
                    // chunk the TUI treats it as part of the paste and never submits.
                    this.write(payload.slice(0, -1));
                    await new Promise((r) => setTimeout(r, this.enterDelayMs));
                    if (this.stopped)
                        return;
                    this.write('\r');
                    delivered.push(msg.id);
                }
                catch {
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
        }
        finally {
            this.ticking = false;
        }
    }
    async safeRequest(method, params) {
        try {
            return await this.rpc.request(method, params);
        }
        catch {
            return null;
        }
    }
}
export function resolveLaunch(argv, defaultCommand) {
    if (argv.length > 0 && !argv[0].startsWith('-')) {
        return { command: argv[0], args: argv.slice(1) };
    }
    return { command: defaultCommand, args: [...argv] };
}
const EXECUTABLE_EXTS = ['.exe', '.com'];
const BATCH_EXTS = ['.cmd', '.bat'];
const SPAWNABLE_EXTS = [...EXECUTABLE_EXTS, ...BATCH_EXTS];
function isBatchFile(file) {
    return BATCH_EXTS.some((ext) => file.toLowerCase().endsWith(ext));
}
function hasExecutableExt(file) {
    return SPAWNABLE_EXTS.some((ext) => file.toLowerCase().endsWith(ext));
}
function defaultExists(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
// node-pty hands the command line straight to CreateProcessW, which appends
// only `.exe` — npm's `.cmd` shims (qodercli etc.) are invisible to it and
// fail with "Cannot create process, error code: 2". Resolve the real target
// ourselves and run batch files through cmd.exe, which node-pty can spawn.
export function resolveWindowsLaunch(command, args, opts = {}) {
    const exists = opts.exists ?? defaultExists;
    const comspec = opts.comspec ?? process.env.ComSpec ?? 'cmd.exe';
    const wrapBatch = (batch) => {
        // A single pre-escaped command line: node-pty re-escapes array args for
        // MSVC argv rules (\"), which cmd.exe cannot parse — the string form is
        // passed through verbatim. The batch path is always quoted so paths with
        // spaces survive cmd's /s quote-stripping (first and last quote removed).
        const inner = [`"${batch}"`, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');
        return { command: comspec, args: `/d /s /c "${inner}"` };
    };
    if (command.includes('\\') || command.includes('/')) {
        const candidates = hasExecutableExt(command)
            ? [command]
            : [command, ...SPAWNABLE_EXTS.map((ext) => command + ext)];
        for (const candidate of candidates) {
            if (!exists(candidate))
                continue;
            return isBatchFile(candidate)
                ? wrapBatch(nodePath.resolve(candidate))
                : { command: candidate, args };
        }
        throw new Error(`dtmcp run: '${command}' not found (cwd and PATH searched)`);
    }
    const dirs = [opts.cwd ?? process.cwd()];
    for (const part of (opts.pathEnv ?? process.env.PATH ?? '').split(nodePath.delimiter)) {
        const dir = part.trim().replace(/^"(.*)"$/, '$1');
        if (dir)
            dirs.push(dir);
    }
    for (const dir of dirs) {
        const candidates = hasExecutableExt(command)
            ? [command, ...SPAWNABLE_EXTS.map((ext) => command + ext)]
            : SPAWNABLE_EXTS.map((ext) => command + ext);
        for (const name of candidates) {
            const candidate = nodePath.join(dir, name);
            if (!exists(candidate))
                continue;
            return isBatchFile(candidate)
                ? wrapBatch(candidate)
                : { command: candidate, args };
        }
    }
    throw new Error(`dtmcp run: cannot find '${command}' (searched cwd and PATH for .exe/.cmd/.bat). ` +
        `Install it, or check dtmcp doctor.`);
}
// Runs `command` inside a PTY, transparently proxying the real terminal,
// while injecting any pending phone messages as if a human had typed them.
// Resolves with the child's exit code.
export function runWrapped(deps, command, args) {
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
    const safeWrite = (d) => {
        try {
            child.write(d);
        }
        catch {
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
        if (loopScheduled)
            return;
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
    return new Promise((resolve) => {
        child.onExit(({ exitCode }) => {
            loop.stop();
            deps.tty.setRawMode(false);
            resolve(exitCode);
        });
    });
}
export async function runCommand(argv) {
    const pty = await import('node-pty');
    const endpoint = ipc.endpoint(identity.instanceId());
    const { command: rawCommand, args: rawArgs } = resolveLaunch(argv, 'qodercli');
    const { command, args } = process.platform === 'win32'
        ? resolveWindowsLaunch(rawCommand, rawArgs)
        : { command: rawCommand, args: rawArgs };
    const tty = {
        setRawMode: (m) => {
            if (process.stdin.isTTY)
                process.stdin.setRawMode(m);
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
    const exitCode = await runWrapped({
        spawn: (cmd, args, opts) => pty.spawn(cmd, args, opts),
        connectRpc: (ep) => {
            const client = new IpcClient(ep);
            void client.connect().catch(() => { });
            return client;
        },
        tty,
        endpoint,
        env: process.env,
        onSignal: (sig, cb) => process.on(sig, cb),
    }, command, args);
    process.exit(exitCode);
}
//# sourceMappingURL=run.js.map