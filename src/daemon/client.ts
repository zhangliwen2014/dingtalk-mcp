import * as net from 'net';

export class IpcClient {
  private socket: net.Socket | null = null;
  private ipcEndpoint: string;
  private requestId = 0;
  private pendingRequests: Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
    }
  > = new Map();
  private buffer = '';

  constructor(ipcEndpoint: string) {
    this.ipcEndpoint = ipcEndpoint;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.ipcEndpoint, () => {
        resolve();
      });

      this.socket.on('error', (err) => {
        reject(err);
      });

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('close', () => {
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error('Connection closed'));
        }
        this.pendingRequests.clear();
      });
    });
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket) {
        this.socket.end(() => {
          this.socket = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  async request(method: string, params: any): Promise<any> {
    if (!this.socket) {
      throw new Error('Not connected');
    }

    const id = ++this.requestId;
    const request = { id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.socket!.write(JSON.stringify(request) + '\n');
    });
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const response = JSON.parse(line);
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            this.pendingRequests.delete(response.id);
            if (response.ok === false) {
              pending.reject(new Error(response.error || 'Unknown error'));
            } else {
              pending.resolve(response);
            }
          }
        } catch (err) {
          // Ignore parse errors
        }
      }
    }
  }
}
