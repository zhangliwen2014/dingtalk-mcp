import { Server } from '@modelcontextprotocol/sdk/server/index.js';
export declare class McpServer {
    private server;
    private client;
    private ipcEndpoint;
    constructor(ipcEndpoint: string);
    start(): Promise<void>;
    stop(): Promise<void>;
    private setupHandlers;
    getServer(): Server;
}
//# sourceMappingURL=mcp-server.d.ts.map