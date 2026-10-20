import { DaemonServer } from './server.js';
import { DwsTransport } from '../transport/dws-transport.js';
import { Switch } from '../core/switch.js';
import { Registry } from '../core/registry.js';
import { SingleInstance } from './single-instance.js';
import { ProjectChatManager } from '../core/project-chat-manager.js';
import { ChatPoller } from './chat-poller.js';
import { AgentRunner } from './agent-runner.js';
import { SessionRegistry } from './session-registry.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as paths from '../platform/paths.js';
import * as ipc from '../platform/ipc.js';
import * as identity from '../platform/identity.js';

const POLL_INTERVAL_MS = 3000;

export function resolveHeadlessEnabled(configDir: string): boolean {
  const env = process.env.DTMCP_AGENT_HEADLESS;
  if (env === '1' || env === 'true') {
    return true;
  }
  if (env === '0' || env === 'false') {
    return false;
  }
  try {
    const raw = fs.readFileSync(path.join(configDir, 'config.json'), 'utf8');
    return JSON.parse(raw)?.agent?.headless === true;
  } catch {
    return false;
  }
}

export class Daemon {
  private server: DaemonServer | null = null;
  private instance: SingleInstance | null = null;
  private transport: DwsTransport | null = null;
  private projectChatManager: ProjectChatManager | null = null;
  private poller: ChatPoller | null = null;
  private agentRunner: AgentRunner | null = null;
  private sessionRegistry: SessionRegistry | null = null;

  async start(): Promise<void> {
    const instanceId = identity.instanceId();
    this.instance = new SingleInstance(instanceId);

    const acquired = await this.instance.tryAcquire();
    if (!acquired) {
      throw new Error('Another daemon instance is already running');
    }

    const configDir = paths.home();
    const ipcEndpoint = ipc.endpoint(instanceId);
    this.transport = new DwsTransport();
    this.projectChatManager = new ProjectChatManager(configDir);
    this.projectChatManager.load();
    const switchControl = new Switch(configDir);
    const registry = new Registry(configDir);
    registry.load();

    this.agentRunner = new AgentRunner({
      configDir,
      send: async (chatId, text) => {
        this.projectChatManager?.recordSentContent(text);
        await this.transport!.sendToGroupChat(chatId, text);
      },
    });

    this.sessionRegistry = new SessionRegistry();
    const headlessEnabled = resolveHeadlessEnabled(configDir);

    this.server = new DaemonServer({
      transport: this.transport,
      switch: switchControl,
      registry,
      ipcEndpoint,
      projectChatManager: this.projectChatManager,
      agentRunner: this.agentRunner,
      sessionRegistry: this.sessionRegistry,
      headlessEnabled,
      onChatCreated: (chatId) => this.listenForChat(chatId),
    });

    this.poller = new ChatPoller({
      transport: this.transport,
      intervalMs: POLL_INTERVAL_MS,
      onMessage: (message) => {
        if (!this.server) {
          return;
        }
        return this.server
          .handleChatMessage(message)
          .catch((err) => console.error('handleChatMessage error:', err));
      },
    });

    await this.server.start();

    for (const chat of this.projectChatManager.listProjectChats()) {
      this.listenForChat(chat.chatId);
    }

    console.log(`Daemon started on ${ipcEndpoint}`);
    console.log(`Instance ID: ${instanceId}`);
    console.log(
      `Polling ${this.projectChatManager.listProjectChats().length} project chat(s) every ${POLL_INTERVAL_MS}ms, agent permission mode: ${this.agentRunner.getPermissionMode()}, headless: ${headlessEnabled}`
    );
  }

  async stop(): Promise<void> {
    if (this.poller) {
      this.poller.stopAll();
      this.poller = null;
    }

    if (this.agentRunner) {
      this.agentRunner.stop();
      this.agentRunner = null;
    }

    if (this.server) {
      await this.server.stop();
      this.server = null;
    }

    if (this.instance) {
      await this.instance.release();
      this.instance = null;
    }
  }

  private listenForChat(chatId: string): void {
    if (!this.poller) {
      return;
    }
    console.log(`Polling chat ${chatId}`);
    this.poller.start(chatId);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const daemon = new Daemon();
  daemon.start().catch((err) => {
    console.error('Failed to start daemon:', err);
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    await daemon.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await daemon.stop();
    process.exit(0);
  });
}
