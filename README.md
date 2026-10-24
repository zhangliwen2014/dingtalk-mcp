# dtmcp - DingTalk MCP Bridge

A bridge that pushes agent questions to your mobile DingTalk, gets answers back, and lets the agent continue working.

## Features

- **Remote Q&A**: When your coding agent needs a decision, the question is pushed to your phone via DingTalk
- **Bidirectional**: Answer from your phone or from the terminal - whichever comes first wins
- **Global switch**: Enable/disable push with `dtmcp on/off`
- **Multi-project**: Handle questions from multiple projects simultaneously with question IDs
- **Cross-platform**: macOS tested; Linux and Windows are designed-compatible (see the compatibility matrix below)
- **Multi-agent**: Compatible with Qoder, Kimi, and other MCP clients

## Installation

### Prerequisites

1. **Node.js >= 20**: [Download](https://nodejs.org/)
   - Windows: `winget install OpenJS.NodeJS.LTS`, then open a **new** terminal (PATH only refreshes in new windows). The installer also puts npm and the global bin dir (`%APPDATA%\npm`) on PATH.
   - Note: agent CLIs like qodercli/Kimi bundle their own runtime — that is **not** Node/npm. `dtmcp` needs a real Node.js install.
2. **dws CLI**: DingTalk Workspace CLI
   - The dws installer below installs **dws only**; `dtmcp` is a separate step further down.
   ```bash
   # macOS/Linux
   curl -fsSL https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.sh | sh
   
   # Windows (PowerShell)
   irm https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.ps1 | iex
   ```
   - Windows installer fails with `Could not determine the latest version` if it can't follow the GitHub `releases/latest` redirect (common behind proxies). Pin the version instead:
     ```powershell
     $env:DWS_VERSION = "v1.0.65"   # latest release; skip version detection
     irm https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.ps1 | iex
     ```
     If the release download itself times out, switch to the Gitee mirror (`$env:DWS_GITEE_REPO = "DingTalk-Real-AI/dingtalk-workspace-cli"`, `$env:DWS_VERSION = "v1.0.63"` — it lags GitHub by a few patch releases).
3. **DingTalk authentication**:
   ```bash
   dws auth login
   ```
   - If your organization hasn't enabled CLI access, you'll need an admin to enable it once at [DingTalk Developer Console](https://open-dev.dingtalk.com) → "CLI Access Management"

### Install dtmcp (from GitHub)

```bash
npm install -g --install-links github:zhangliwen2014/dingtalk-mcp#v0.1.2
```

`--install-links` avoids an npm 11 bug where Git dependencies can end up as symlinks to a temporary clone that is deleted afterwards.

Compiled JavaScript is committed under `dist/`, so Git installs need no build step or TypeScript toolchain. Verify with:

```bash
dtmcp doctor
```

To track the latest commit instead of the pinned release:

```bash
npm install -g --install-links github:zhangliwen2014/dingtalk-mcp#main
```

Alternative without Git — install the tagged source archive directly. This is also the **recommended path on Windows**, where npm's Git-dependency handling can fail with `ENOTEMPTY` or `spawn ... ENOENT` (verified working on a Windows 11 box):

```bash
npm install -g https://github.com/zhangliwen2014/dingtalk-mcp/archive/refs/tags/v0.1.2.tar.gz
```

On npm >= 11.19 install scripts are blocked by default; add `--allow-scripts=dtmcp,node-pty` to either command (or accept npm's warning — node-pty ships win32/darwin prebuilds that load without scripts).

> Not published to npm yet, so `npm install -g dtmcp` does not work.

Installing from Git requires `git` and network access to GitHub.

### Upgrade

Re-run the install command with the new tag — npm replaces the global package in place, no uninstall needed:

```bash
# Git install (macOS / Linux)
npm install -g --install-links --allow-scripts=dtmcp,node-pty github:zhangliwen2014/dingtalk-mcp#v0.1.2

# Archive install (recommended on Windows)
npm install -g --allow-scripts=dtmcp,node-pty https://github.com/zhangliwen2014/dingtalk-mcp/archive/refs/tags/v0.1.2.tar.gz
```

Then restart the daemon — a running one keeps the old code in memory:

```bash
pkill -f 'dtmcp/dist/cli/index.js daemon'
nohup dtmcp daemon >/dev/null 2>&1 &
```

Windows PowerShell:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dtmcp.*daemon' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Process -WindowStyle Hidden dtmcp -ArgumentList daemon
```

Pending questions survive upgrades (`state.json` under `~/.dtmcp` / `%APPDATA%\dtmcp`). Verify with `dtmcp --version` (or `npm ls -g dtmcp --depth=0`). Agent MCP sessions start a fresh `dtmcp mcp` per session and pick up the new code on reconnect; restart any running `dtmcp run` wrapper too.

### Platform compatibility

| Platform | Status | Notes |
|---|---|---|
| macOS (arm64 / x64) | ✅ Live-tested | Reference platform; node-pty ships prebuilds |
| Linux (Ubuntu) | 🟡 Designed-compatible, not live-tested | node-pty has no Linux prebuild: install `python3 make g++` first; daemon uses Unix sockets |
| Windows | 🟡 Partially live-tested (2026-10-23, Win11 + Node 24) | npm Git-依赖在 Windows 报 `ENOTEMPTY`/`spawn cmd.exe ENOENT` → 用 archive tarball 安装；node-pty win32-x64 预编译实测可 spawn（无需跑安装脚本）；`dtmcp run` 启动 agent CLI 实测可用（`.exe` 直启、`.cmd` 经 `cmd.exe` 包装）；命名管道 daemon 实测可用（`doctor`/`status`/`ask`/`check_answer`），手机回传尚待人工回复才算闭环 |

> **Windows 下 `dtmcp run` 报 `Error: Cannot create process, error code: 2`**：旧版本把命令原样交给 `CreateProcessW`，它只解析 `.exe`，而 npm 全局安装的 CLI（qodercli/Kimi/claude）在 Windows 上是 `.cmd` 批处理包装。v0.1.1 起已修复：`dtmcp run` 会按 cwd→PATH 解析 `.exe`，`.cmd/.bat` 自动经 `cmd.exe /d /s /c` 启动。v0.1.0 及更早的已装版本按 [Upgrade](#upgrade) 重装并重启 daemon。

## Quick Start

1. **Check prerequisites**:
   ```bash
   dtmcp doctor
   ```

2. **Start the daemon** (keep it running; MCP talks to it over IPC):
   ```bash
   dtmcp daemon
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
         "command": "dtmcp",
         "args": ["mcp"]
       }
     }
   }
   ```
   The project group chat is created automatically on the first `ask_on_dingtalk` call, or by `dtmcp run` when it starts.

5. **Test it**: Ask your agent a question that requires human input. You'll receive it on your phone!

## CLI Commands

```bash
dtmcp version             # Print the version (also: dtmcp --version / -v)
dtmcp doctor              # Check all prerequisites
dtmcp status              # Show current status
dtmcp on                  # Enable push to DingTalk
dtmcp off                 # Disable push to DingTalk
dtmcp pending             # List pending questions
dtmcp daemon              # Start the background daemon (IPC + polling)
dtmcp mcp                 # Start the MCP server (stdio)
dtmcp install-hooks       # Register dtmcp hooks into ~/.qoder/settings.json
dtmcp run [agent args]    # Wrap an agent TUI (qodercli/kimi/claude) for phone injection
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
