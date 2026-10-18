import { Switch } from '../core/switch.js';
import { Registry } from '../core/registry.js';
import { DingTransport } from '../transport/ding-transport.js';
import { route } from '../core/router.js';
import { BlockedReason } from '../core/errors.js';
import * as net from 'net';
import * as fs from 'fs';

export interface DaemonServerOptions {
  transport: DingTransport;
  switch: Switch;
  registry: Registry;
  ipcEndpoint: string;
}

export class DaemonServer {
  private server: net.Server | null = null;
  private transport: DingTransport;
  private switch: Switch;
  private registry: Registry;
  private ipcEndpoint: string;

  constructor(options: DaemonServerOptions) {
    this.transport = options.transport;
    this.switch = options.switch;
    this.registry = options.registry;
    this.ipcEndpoint = options.ipcEndpoint;
  }

  async start(): Promise<void> {
    if (fs.existsSync(this.ipcEndpoint)) {
      fs.unlinkSync(this.ipcEndpoint);
    }

    return new Promise((resolve) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.listen(this.ipcEndpoint, () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          if (fs.existsSync(this.ipcEndpoint)) {
            fs.unlinkSync(this.ipcEndpoint);
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  async rpc(method: string, params: any): Promise<any> {
    switch (method) {
      case 'hello':
        return this.handleHello(params);
      case 'ask':
        return this.handleAsk(params);
      case 'check':
        return this.handleCheck(params);
      case 'cancel':
        return this.handleCancel(params);
      case 'status':
        return this.handleStatus(params);
      case 'set_switch':
        return this.handleSetSwitch(params);
      case 'reply':
      case 'ingest':
        return this.handleIngest(params);
      default:
        throw new Error(`Unknown RPC method: ${method}`);
    }
  }

  private async handleHello(params: { version: string }): Promise<any> {
    return {
      ok: true,
      version: '1.0.0',
      instanceId: this.registry.instanceId,
    };
  }

  private async handleAsk(params: {
    question: string;
    target: string;
  }): Promise<any> {
    console.log('[Ask] Starting, target:', params.target);
    
    const enabled = await this.switch.get();
    if (!enabled) {
      return {
        ok: true,
        status: 'blocked',
        reason: BlockedReason.DISABLED,
      };
    }

    console.log('[Ask] Resolving target...');
    const targetId = await this.transport.resolveTarget(params.target);
    console.log('[Ask] Target resolved to:', targetId);
    
    const id = this.registry.allocateId();
    console.log('[Ask] Allocated ID:', id);
    
    const question = this.registry.add({
      id,
      text: params.question,
      target: targetId,
    });

    const message = `#Q${id}: ${params.question}`;
    console.log('[Ask] Sending message:', message);
    await this.transport.sendText(targetId, message);
    console.log('[Ask] Message sent');

    this.registry.save();
    console.log('[Ask] Registry saved');

    return {
      ok: true,
      status: 'pending',
      id,
    };
  }

  private async handleCheck(params: { id: number }): Promise<any> {
    const question = this.registry.get(params.id);
    if (!question) {
      throw new Error(`Question ${params.id} not found`);
    }

    if (question.status === 'answered') {
      return {
        ok: true,
        status: 'answered',
        answer: question.answer,
        answeredVia: question.answeredVia,
      };
    }

    return {
      ok: true,
      status: question.status,
    };
  }

  private async handleCancel(params: { id: number }): Promise<any> {
    const question = this.registry.get(params.id);
    if (!question) {
      throw new Error(`Question ${params.id} not found`);
    }

    question.cancel();
    this.registry.save();

    return {
      ok: true,
      status: 'cancelled',
    };
  }

  private async handleStatus(params: {}): Promise<any> {
    const enabled = await this.switch.get();
    const pending = this.registry.listPending();

    return {
      ok: true,
      enabled,
      pendingCount: pending.length,
    };
  }

  private async handleSetSwitch(params: { enabled: boolean }): Promise<any> {
    await this.switch.set(params.enabled);
    return { ok: true };
  }

  private async handleIngest(params: { text: string }): Promise<any> {
    console.log('[Ingest] Received text:', params.text);
    
    const pending = this.registry.listPending();
    console.log('[Ingest] Pending questions:', pending.length);
    
    const result = route(params.text, pending);
    console.log('[Ingest] Route result:', result);

    if (result.kind === 'command') {
      if (result.cmd === 'enable') {
        await this.switch.set(true);
      } else if (result.cmd === 'disable') {
        await this.switch.set(false);
      } else if (result.cmd === 'cancel' && result.targetId !== undefined) {
        const q = this.registry.get(result.targetId);
        if (q) {
          q.cancel();
          this.registry.save();
        }
      }
      return { ok: true, routed: 'command' };
    }

    if (result.kind === 'answer') {
      const question = this.registry.get(result.id);
      if (question) {
        question.accept(result.text, 'phone');
        this.registry.save();
        console.log('[Ingest] Answer accepted for Q' + result.id);
      } else {
        console.log('[Ingest] Question Q' + result.id + ' not found');
      }
      return { ok: true, routed: 'answer', id: result.id };
    }

    if (result.kind === 'ambiguous') {
      console.log('[Ingest] Ambiguous - multiple pending questions');
      return { ok: false, error: 'ambiguous', routed: 'none' };
    }

    console.log('[Ingest] No route matched');
    return { ok: true, routed: 'none' };
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const request = JSON.parse(line);
            this.handleRequest(socket, request);
          } catch (err) {
            const response = {
              ok: false,
              error: err instanceof Error ? err.message : 'Unknown error',
            };
            socket.write(JSON.stringify(response) + '\n');
          }
        }
      }
    });
  }

  private async handleRequest(
    socket: net.Socket,
    request: { id: number; method: string; params: any }
  ): Promise<void> {
    try {
      const result = await this.rpc(request.method, request.params);
      const response = { id: request.id, ...result };
      socket.write(JSON.stringify(response) + '\n');
    } catch (err) {
      const response = {
        id: request.id,
        ok: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
      socket.write(JSON.stringify(response) + '\n');
    }
  }
}
