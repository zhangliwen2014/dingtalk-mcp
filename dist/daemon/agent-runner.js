import { spawn } from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as paths from '../platform/paths.js';
const DEFAULT_ACK_DELAY_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_LEN = 2000;
const CONFIG_FILE = 'config.json';
const SYSTEM_PROMPT = '你收到的这条消息来自手机钉钉（用户远程发来的）。' +
    '请把它当作本机 CLI 里用户直接输入的同一条消息来处理与回答，该做什么就做什么。' +
    '你的最终回复会被原样转发到钉钉群，因此：使用纯文本，不要用 markdown 表格；尽量简短；先给结论，再给必要细节；' +
    '如果执行了改动，说明改了什么、结果如何。';
function buildArgs(project, content, mode) {
    const args = [
        '-p',
        '--output-format',
        'json',
        '--strict-mcp-config',
        '--no-session-persistence',
        '-w',
        project.workdir,
        '--append-system-prompt',
        SYSTEM_PROMPT,
    ];
    if (mode === 'full') {
        args.push('--dangerously-skip-permissions');
    }
    else if (mode === 'read-only') {
        args.push('--tools', 'read', 'grep', 'glob');
    }
    else {
        args.push('--permission-mode', 'accept_edits');
    }
    args.push(content);
    return args;
}
function resolvePermissionMode(option, configDir) {
    if (option) {
        return option;
    }
    const env = process.env.DTMCP_AGENT_PERMISSION_MODE;
    if (env === 'full' || env === 'read-only' || env === 'accept-edits') {
        return env;
    }
    try {
        const raw = fs.readFileSync(path.join(configDir, CONFIG_FILE), 'utf8');
        const value = JSON.parse(raw)?.agent?.permissionMode;
        if (value === 'full' || value === 'read-only' || value === 'accept-edits') {
            return value;
        }
    }
    catch {
        // no config file — fall through to default
    }
    return 'full';
}
export class AgentRunner {
    send;
    ackDelayMs;
    timeoutMs;
    maxLen;
    permissionMode;
    command;
    queue = [];
    running = false;
    current = null;
    constructor(options) {
        this.send = options.send;
        this.ackDelayMs = options.ackDelayMs ?? DEFAULT_ACK_DELAY_MS;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.maxLen = options.maxLen ?? DEFAULT_MAX_LEN;
        this.command = options.command ?? 'qodercli';
        this.permissionMode = resolvePermissionMode(options.permissionMode, options.configDir ?? paths.home());
    }
    getPermissionMode() {
        return this.permissionMode;
    }
    enqueue(project, content) {
        this.queue.push({ project, content });
        if (!this.running) {
            void this.drain();
        }
    }
    stop() {
        this.queue = [];
        this.running = false;
        const current = this.current;
        if (!current) {
            return;
        }
        this.current = null;
        const control = current.control;
        if (!control.settled) {
            control.settled = true;
            if (control.ackTimer) {
                clearTimeout(control.ackTimer);
            }
            if (control.timeoutTimer) {
                clearTimeout(control.timeoutTimer);
            }
            current.child.kill();
            control.resolve?.(null);
        }
        else {
            current.child.kill();
        }
    }
    async drain() {
        this.running = true;
        while (this.queue.length > 0) {
            const item = this.queue.shift();
            if (!item) {
                break;
            }
            await this.runOne(item.project, item.content);
        }
        this.running = false;
    }
    async runOne(project, content) {
        const chatId = project.chatId;
        const control = { settled: false };
        const outcome = await new Promise((resolve) => {
            control.resolve = resolve;
            const child = spawn(this.command, buildArgs(project, content, this.permissionMode), {
                cwd: project.workdir,
                env: { ...process.env, DTMCP_HEADLESS: '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            const finish = (value) => {
                if (control.settled) {
                    return;
                }
                control.settled = true;
                if (control.ackTimer) {
                    clearTimeout(control.ackTimer);
                }
                if (control.timeoutTimer) {
                    clearTimeout(control.timeoutTimer);
                }
                this.current = null;
                resolve(value);
            };
            control.ackTimer = setTimeout(() => {
                if (control.settled) {
                    return;
                }
                void this.send(chatId, '已收到你的消息，正在处理，完成后推送结果。').catch((err) => console.error('Failed to send working-soon notice:', err));
            }, this.ackDelayMs);
            control.timeoutTimer = setTimeout(() => {
                child.kill();
                finish('⏱ 处理超时，请在电脑端查看。');
            }, this.timeoutMs);
            this.current = { child, control };
            child.stdout?.on('data', (data) => {
                stdout += data;
            });
            child.stderr?.on('data', (data) => {
                stderr += data;
            });
            child.on('close', () => {
                finish(this.interpret(stdout, stderr));
            });
            child.on('error', (err) => {
                finish(`⚠️ 无法启动处理进程：${err.message}`);
            });
        });
        if (outcome !== null) {
            await this.deliver(chatId, outcome);
        }
    }
    interpret(stdout, stderr) {
        const parsed = this.lastResult(stdout);
        if (!parsed) {
            const detail = (stderr || stdout).trim().slice(0, 200);
            return `❌ 处理失败：${detail || '无输出'}`;
        }
        if (parsed.is_error) {
            return `❌ 处理失败：${String(parsed.result ?? '未知错误').slice(0, 200)}`;
        }
        const text = String(parsed.result ?? '').trim();
        if (!text) {
            return '（处理完成，但没有可回报的内容）';
        }
        return text;
    }
    lastResult(stdout) {
        const lines = stdout.split('\n').filter((l) => l.trim());
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const value = JSON.parse(lines[i]);
                if (value && typeof value === 'object' && 'type' in value && value.type === 'result') {
                    return { is_error: Boolean(value.is_error), result: value.result };
                }
            }
            catch {
                // not JSON, keep looking
            }
        }
        return null;
    }
    async deliver(chatId, text) {
        const payload = text.length > this.maxLen
            ? `${text.slice(0, this.maxLen)}…（已截断，详见电脑端）`
            : text;
        try {
            await this.send(chatId, payload);
        }
        catch (err) {
            console.error('Failed to deliver agent result:', err);
        }
    }
}
//# sourceMappingURL=agent-runner.js.map