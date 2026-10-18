import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(args: string[]): Promise<RunResult> {
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

export function spawnDetached(args: string[]): void {
  const [command, ...commandArgs] = args;
  spawn(command, commandArgs, {
    shell: false,
    detached: true,
    stdio: 'ignore'
  }).unref();
}
