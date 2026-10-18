import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { IpcClient } from '../daemon/client.js';

export class McpServer {
  private server: Server;
  private client: IpcClient;
  private ipcEndpoint: string;

  constructor(ipcEndpoint: string) {
    this.ipcEndpoint = ipcEndpoint;
    this.client = new IpcClient(ipcEndpoint);

    this.server = new Server(
      {
        name: 'dingtalk-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  async start(): Promise<void> {
    await this.client.connect();
  }

  async stop(): Promise<void> {
    await this.client.disconnect();
    await this.server.close();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'ask_on_dingtalk',
          description:
            'Send a question to DingTalk mobile and wait for answer',
          inputSchema: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The question to ask',
              },
              target: {
                type: 'string',
                description: 'DingTalk user to send to (e.g., "self")',
              },
            },
            required: ['question', 'target'],
          },
        },
        {
          name: 'check_answer',
          description: 'Check if a question has been answered',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'number',
                description: 'Question ID',
              },
            },
            required: ['id'],
          },
        },
        {
          name: 'cancel_question',
          description: 'Cancel a pending question',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'number',
                description: 'Question ID to cancel',
              },
            },
            required: ['id'],
          },
        },
        {
          name: 'dingtalk_status',
          description: 'Get DingTalk push status and pending question count',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let result: any;

        switch (name) {
          case 'ask_on_dingtalk':
            result = await this.client.request('ask', {
              question: args?.question,
              target: args?.target,
            });
            break;

          case 'check_answer':
            result = await this.client.request('check', { id: args?.id });
            break;

          case 'cancel_question':
            result = await this.client.request('cancel', { id: args?.id });
            break;

          case 'dingtalk_status':
            result = await this.client.request('status', {});
            break;

          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: error instanceof Error ? error.message : 'Unknown error',
              }),
            },
          ],
          isError: true,
        };
      }
    });
  }

  getServer(): Server {
    return this.server;
  }
}
