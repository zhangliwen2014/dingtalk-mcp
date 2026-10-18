import { DaemonServer } from './server.js';
import { DwsTransport } from '../transport/dws-transport.js';
import { Switch } from '../core/switch.js';
import { Registry } from '../core/registry.js';
import { SingleInstance } from './single-instance.js';
import * as paths from '../platform/paths.js';
import * as ipc from '../platform/ipc.js';
import * as identity from '../platform/identity.js';
import { spawn, ChildProcess } from 'child_process';

export class Daemon {
  private server: DaemonServer | null = null;
  private instance: SingleInstance | null = null;
  private dwsProcess: ChildProcess | null = null;

  async start(): Promise<void> {
    const instanceId = identity.instanceId();
    this.instance = new SingleInstance(instanceId);

    const acquired = await this.instance.tryAcquire();
    if (!acquired) {
      throw new Error('Another daemon instance is already running');
    }

    const configDir = paths.home();
    const ipcEndpoint = ipc.endpoint(instanceId);
    const transport = new DwsTransport();
    const switchControl = new Switch(configDir);
    const registry = new Registry(configDir);
    registry.load();

    this.server = new DaemonServer({
      transport,
      switch: switchControl,
      registry,
      ipcEndpoint,
    });

    await this.server.start();
    this.startDwsListener(transport);

    console.log(`Daemon started on ${ipcEndpoint}`);
    console.log(`Instance ID: ${instanceId}`);
  }

  async stop(): Promise<void> {
    if (this.dwsProcess) {
      this.dwsProcess.kill();
      this.dwsProcess = null;
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

  private startDwsListener(transport: DwsTransport): void {
    this.dwsProcess = spawn('dws', ['event', '+listen-im', '--kind', 'all-direct'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.dwsProcess.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            const event = JSON.parse(line);
            if (event.type === 'message' && event.text) {
              transport.handleInbound({
                senderId: event.senderId || 'unknown',
                text: event.text,
                conversationId: event.conversationId || '',
                timestamp: event.timestamp || Date.now(),
              });
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    });

    this.dwsProcess.stderr?.on('data', (data) => {
      console.error('dws event error:', data.toString());
    });

    this.dwsProcess.on('close', (code) => {
      console.log(`dws event listener exited with code ${code}`);
      this.dwsProcess = null;
    });
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
