#!/usr/bin/env node

import { Switch } from '../core/switch.js';
import { Registry } from '../core/registry.js';
import * as paths from '../platform/paths.js';
import * as identity from '../platform/identity.js';
import * as proc from '../platform/proc.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function main() {
  const command = process.argv[2];

  switch (command) {
    case 'doctor':
      await runDoctor();
      break;
    case 'status':
      runStatus();
      break;
    case 'on':
      new Switch().set(true);
      console.log('✓ Push enabled');
      break;
    case 'off':
      new Switch().set(false);
      console.log('✓ Push disabled');
      break;
    case 'pending':
      runPending();
      break;
    default:
      console.log(`Usage: dtmcp <command>

Commands:
  doctor    Check prerequisites
  status    Show current status
  on        Enable push to DingTalk
  off       Disable push to DingTalk
  pending   List pending questions
`);
  }
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
  console.log(`✓ Push enabled: ${sw.isEnabled()}`);

  // Check registry
  const registry = new Registry();
  registry.load();
  const pending = registry.listPending();
  console.log(`✓ Pending questions: ${pending.length}`);

  console.log(`\nInstance ID: ${identity.instanceId()}`);
}

function runStatus() {
  const sw = new Switch();
  console.log(`Push enabled: ${sw.isEnabled()}`);

  const registry = new Registry();
  registry.load();
  const pending = registry.listPending();
  console.log(`Pending questions: ${pending.length}`);

  if (pending.length > 0) {
    console.log('\nPending:');
    for (const q of pending) {
      console.log(`  Q${q.id}: ${q.text} (${q.projectId})`);
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
    if (q.options.length > 0) {
      console.log(`  Options: ${q.options.join(', ')}`);
    }
    console.log(`  Project: ${q.projectId}`);
    console.log(`  Asked: ${new Date(q.askedAt!).toISOString()}`);
    console.log();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
