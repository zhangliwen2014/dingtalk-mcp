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
            'Send a question to DingTalk project group chat and wait for answer',
          inputSchema: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The question to ask',
              },
              project_id: {
                type: 'string',
                description:
                  'Project identifier - isolates questions per project (e.g., "website-rewrite", "mobile-app")',
              },
              project_title: {
                type: 'string',
                description:
                  'Human-readable project name shown in DingTalk chat title (e.g., "官网重构")',
              },
            },
            required: ['question', 'project_id', 'project_title'],
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
        {
          name: 'list_projects',
          description: 'List all project chats with their status',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'read_project_messages',
          description:
            'Read unread messages from a project\'s DingTalk inbox. Messages sent by users without a pending question are stored here.',
          inputSchema: {
            type: 'object',
            properties: {
              project_id: {
                type: 'string',
                description: 'Project identifier to read messages from',
              },
            },
            required: ['project_id'],
          },
        },
        {
          name: 'list_project_inboxes',
          description:
            'List all project chats with unread message counts. Use this to discover which projects have new proactive messages.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'reply_to_project',
          description:
            'Push a reply (or status update) to the project DingTalk group chat so the user sees it on their phone. Use after read_project_messages, or proactively to report work status.',
          inputSchema: {
            type: 'object',
            properties: {
              project_id: {
                type: 'string',
                description: 'Project identifier of the target group chat',
              },
              content: {
                type: 'string',
                description: 'The reply or status message to send to the group',
              },
            },
            required: ['project_id', 'content'],
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
              project_id: args?.project_id,
              project_title: args?.project_title,
              cwd: process.cwd(),
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

          case 'list_projects':
            result = await this.client.request('list_projects', {});
            break;

          case 'read_project_messages':
            result = await this.client.request('read_project_messages', {
              project_id: args?.project_id,
            });
            break;

          case 'list_project_inboxes':
            result = await this.client.request('list_project_inboxes', {});
            break;

          case 'reply_to_project':
            result = await this.client.request('reply_to_project', {
              project_id: args?.project_id,
              content: args?.content,
            });
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
