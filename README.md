# dtmcp - DingTalk MCP Bridge

A bridge that pushes agent questions to your mobile DingTalk, gets answers back, and lets the agent continue working.

## Features

- **Remote Q&A**: When your coding agent needs a decision, the question is pushed to your phone via DingTalk
- **Bidirectional**: Answer from your phone or from the terminal - whichever comes first wins
- **Global switch**: Enable/disable push with `dtmcp on/off`
- **Multi-project**: Handle questions from multiple projects simultaneously with question IDs
- **Cross-platform**: Works on macOS, Windows, and Linux
- **Multi-agent**: Compatible with Qoder, Kimi, and other MCP clients

## Installation

### Prerequisites

1. **Node.js >= 20**: [Download](https://nodejs.org/)
2. **dws CLI**: DingTalk Workspace CLI
   ```bash
   # macOS/Linux
   curl -fsSL https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.sh | sh
   
   # Windows (PowerShell)
   irm https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.ps1 | iex
   ```
3. **DingTalk authentication**:
   ```bash
   dws auth login
   ```
   - If your organization hasn't enabled CLI access, you'll need an admin to enable it once at [DingTalk Developer Console](https://open-dev.dingtalk.com) → "CLI Access Management"

### Install dtmcp

```bash
npm install -g dtmcp
```

Or use directly with npx (no installation needed):

```bash
npx -y dtmcp doctor
```

## Quick Start

1. **Check prerequisites**:
   ```bash
   dtmcp doctor
   ```

2. **Initialize target conversation** (sends test message to yourself):
   ```bash
   dtmcp init
   ```

3. **Enable push**:
   ```bash
   dtmcp on
   ```

4. **Configure your agent** (e.g., in Qoder's MCP config):
   ```json
   {
     "mcpServers": {
       "dingtalk-mcp": {
         "command": "npx",
         "args": ["-y", "dtmcp", "mcp"]
       }
     }
   }
   ```

5. **Test it**: Ask your agent a question that requires human input. You'll receive it on your phone!

## CLI Commands

```bash
dtmcp doctor              # Check all prerequisites
dtmcp init                # Initialize target conversation
dtmcp status              # Show current status
dtmcp on                  # Enable push to DingTalk
dtmcp off                 # Disable push to DingTalk
dtmcp pending             # List pending questions
dtmcp reply <id> <text>   # Answer a pending question from terminal
```

## How It Works

1. **Agent asks a question**: The MCP tool `ask_on_dingtalk` is called with the question text
2. **Push to phone**: The question is sent to your DingTalk with a unique ID (e.g., `Q3`)
3. **You answer**: Reply on your phone with `#Q3: your answer` or answer from terminal with `dtmcp reply 3 "your answer"`
4. **Agent continues**: The answer is returned to the agent, which resumes work

### Question Routing

When multiple questions are pending, use question IDs to route answers:

- `#Q3: keep backup` - Answer question 3
- `#开` / `#关` - Enable/disable push (command, not an answer)
- `#忽略3` - Cancel question 3

If only one question is pending, you can just reply without the ID.

## Architecture

```
┌────────────┐  stdio MCP   ┌──────────────┐   IPC          ┌──────────────┐
│ Qoder CLI  │─────────────▶│ dtmcp mcp    │──────────────▶│   dtmcpd     │
│ Kimi CLI   │─────────────▶│ (thin client)│               │  (daemon)    │
└────────────┘              └──────────────┘               └──────┬───────┘
                                                                  │
                                                                  ▼
                                                           ┌──────────────┐
                                                           │     dws      │
                                                           │ (DingTalk)   │
                                                           └──────────────┘
```

- **Thin MCP client**: Each agent spawns its own MCP server process
- **Single daemon**: One daemon handles all DingTalk communication, preventing message routing conflicts
- **Cross-platform IPC**: Unix sockets on POSIX, named pipes on Windows

## Privacy & Security

- **Messages stay in your DingTalk**: Questions and answers are sent via your personal DingTalk account and stored in your chat history
- **No external servers**: All communication is between your machine and DingTalk's servers
- **Local state**: Pending questions and configuration are stored in `~/.dtmcp/` (or `%APPDATA%\dtmcp` on Windows)
- **Minimal data**: Only the question text and project name are pushed to your phone by default

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build

# Run CLI locally
node dist/cli/index.js doctor
```

## Roadmap

- **Phase 1** (current): Agent asks questions → phone answers → agent continues
- **Phase 2**: Tool authorization approval (dangerous operations pushed to phone)
- **Phase 3**: Task completion / error notifications (one-way)
- **Phase 4**: Bidirectional control (issue commands from phone)

## License

Apache-2.0

## Contributing

Contributions welcome! Please open an issue or PR on [GitHub](https://github.com/yourusername/dtmcp).
