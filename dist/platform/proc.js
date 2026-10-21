import { spawn } from 'node:child_process';
export async function run(args) {
    return new Promise((resolve) => {
        const [command, ...commandArgs] = args;
        const child = spawn(command, commandArgs, {
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (data) => {
            stdout += data;
        });
        child.stderr.on('data', (data) => {
            stderr += data;
        });
        child.on('close', (code) => {
            resolve({
                code: code ?? 1,
                stdout,
                stderr
            });
        });
        child.on('error', () => {
            resolve({
                code: 1,
                stdout,
                stderr: stderr || 'spawn error'
            });
        });
    });
}
export function spawnDetached(args) {
    const [command, ...commandArgs] = args;
    spawn(command, commandArgs, {
        shell: false,
        detached: true,
        stdio: 'ignore'
    }).unref();
}
//# sourceMappingURL=proc.js.map