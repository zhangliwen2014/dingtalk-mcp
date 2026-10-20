#!/usr/bin/env node

import { Switch } from '../core/switch.js';
import { Registry } from '../core/registry.js';
import * as paths from '../platform/paths.js';
import * as identity from '../platform/identity.js';
import * as ipc from '../platform/ipc.js';
import * as proc from '../platform/proc.js';
import { Daemon } from '../daemon/index.js';
import { startMcpServer } from '../mcp/index.js';
import { IpcClient } from '../daemon/client.js';
import { runHook, type HookInput } from './hook.js';
import { runCommand } from './run.js';
import { installHooksFile } from './install-hooks.js';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

async function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const done = () => {
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

async function runHookCommand(): Promise<void> {
  try {
    if (process.env.DTMCP_HEADLESS) {
      return;
    }

    const raw = await readStdin(1500);
    if (!raw.trim()) {
      return;
    }

    const input = JSON.parse(raw) as HookInput;
    const ipcEndpoint = ipc.endpoint(identity.instanceId());
    const client = new IpcClient(ipcEndpoint);
    await client.connect();
    try {
      const output = await runHook(input, client, process.env);
      if (output) {
        process.stdout.write(output);
      }
    } finally {
      await client.disconnect();
    }
  } catch {
    // Hooks must never break or slow down the CLI session.
  }
}

async function main() {
  const command = process.argv[2];

  switch (command) {
    case 'doctor':
      await runDoctor();
      break;
    case 'status':
      await runStatus();
      break;
    case 'on':
      await new Switch().set(true);
      console.log('✓ Push enabled');
      break;
    case 'off':
      await new Switch().set(false);
      console.log('✓ Push disabled');
      break;
    case 'pending':
      runPending();
      break;
    case 'daemon':
      await startDaemon();
      break;
    case 'mcp':
      await startMcpServer();
      break;
    case 'hook':
      await runHookCommand();
      break;
    case 'install-hooks':
      await runInstallHooks();
      break;
    case 'run':
      await runCommand(process.argv.slice(3));
      break;
    default:
      console.log(`Usage: dtmcp <command>

Commands:
  doctor    Check prerequisites
  status    Show current status
  on        Enable push to DingTalk
  off       Disable push to DingTalk
  pending   List pending questions
  daemon    Start the daemon server
  mcp         Start the MCP server (for agent integration)
  hook           Run as a qodercli hook (internal)
  install-hooks  Register dtmcp hooks into ~/.qoder/settings.json
  run            Launch qodercli inside a PTY with phone-message injection
`);
  }
}

async function runInstallHooks() {
  const settingsPath = nodePath.join(os.homedir(), '.qoder', 'settings.json');

  let command = 'dtmcp hook';
  const which = await proc.run(['which', 'dtmcp']);
  if (which.code !== 0) {
    const selfPath = fileURLToPath(import.meta.url);
    command = `node ${JSON.stringify(selfPath)} hook`;
  }

  installHooksFile(settingsPath, command);
  console.log(`✓ Hooks registered in ${settingsPath}`);
  console.log(`  command: ${command}`);
  console.log('  A backup was written as settings.json.bak (if the file existed).');
  console.log('  Restart any running qodercli sessions to pick up the hooks.');
}

async function runDoctor() {
  console.log('dtmcp doctor\n');

  // Check Node version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (major >= 20) {
    console.log(`✓ Node.js ${nodeVersion} (>= 20 required)`);
  } else {
    console.log(`✗ Node.js ${nodeVersion} (>= 20 required)`);
  }

  // Check DTMCP_HOME
  const home = paths.home();
  console.log(`✓ Config directory: ${home}`);

  // Check dws
  try {
    const result = await proc.run(['dws', 'version']);
    if (result.code === 0) {
      console.log(`✓ dws installed: ${result.stdout.trim()}`);
    } else {
      console.log(`✗ dws not found or error`);
    }
  } catch {
    console.log(`✗ dws not found. Install: curl -fsSL https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.sh | sh`);
  }

  // Check dws auth
  try {
    const result = await proc.run(['dws', 'auth', 'status', '--format', 'json']);
    if (result.code === 0) {
      const status = JSON.parse(result.stdout);
      if (status.authenticated) {
        console.log(`✓ dws authenticated`);
      } else {
        console.log(`✗ dws not authenticated. Run: dws auth login`);
      }
    }
  } catch {
    console.log(`✗ Could not check dws auth status`);
  }

  // Check switch
  const sw = new Switch();
  const enabled = await sw.get();
  console.log(`✓ Push enabled: ${enabled}`);

  // Check registry
  const registry = new Registry();
  registry.load();
  const pending = registry.listPending();
  console.log(`✓ Pending questions: ${pending.length}`);

  console.log(`\nInstance ID: ${identity.instanceId()}`);
}

async function runStatus() {
  const sw = new Switch();
  const enabled = await sw.get();
  console.log(`Push enabled: ${enabled}`);

  const registry = new Registry();
  registry.load();
  const pending = registry.listPending();
  console.log(`Pending questions: ${pending.length}`);

  if (pending.length > 0) {
    console.log('\nPending:');
    for (const q of pending) {
      console.log(`  Q${q.id}: ${q.text}`);
    }
  }
}

function runPending() {
  const registry = new Registry();
  registry.load();
  const pending = registry.listPending();

  if (pending.length === 0) {
    console.log('No pending questions');
    return;
  }

  for (const q of pending) {
    console.log(`Q${q.id}: ${q.text}`);
    console.log(`  Asked: ${new Date(q.askedAt!).toISOString()}`);
    console.log();
  }
}

async function startDaemon() {
  const daemon = new Daemon();
  await daemon.start();

  process.on('SIGINT', async () => {
    await daemon.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await daemon.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
