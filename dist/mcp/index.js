import { McpServer } from './mcp-server.js';
import * as ipc from '../platform/ipc.js';
import * as identity from '../platform/identity.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
export async function startMcpServer() {
    const instanceId = identity.instanceId();
    const ipcEndpoint = ipc.endpoint(instanceId);
    const mcpServer = new McpServer(ipcEndpoint);
    await mcpServer.start();
    const transport = new StdioServerTransport();
    await mcpServer.getServer().connect(transport);
    console.error(`MCP server started, connected to daemon at ${ipcEndpoint}`);
}
if (import.meta.url === `file://${process.argv[1]}`) {
    startMcpServer().catch((err) => {
        console.error('Failed to start MCP server:', err);
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map