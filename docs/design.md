# 设计文档：dingtalk-mcp（钉钉远程问答桥）

版本：v2.8（`dtmcp doctor` 自报版本；v2.7 安装/升级文档按 OS 拆分与一致性巡检）
日期：2026-10-20
关联文档：[需求文档](./requirements.md)

---

## 1. 系统上下文

本项目不直接对接钉钉开放平台协议，而是把钉钉的收发能力外包给官方开源的 `dws` CLI，自己只实现「问答编排」这一层语义：待答状态、开关、回复归属、两端先到先得、超时与回查。

```
┌────────────┐  stdio MCP   ┌──────────────┐   本机 IPC      ┌──────────────┐
│ Qoder CLI  │─────────────▶│ dtmcp mcp    │──────────────▶│              │
│ Kimi CLI   │─────────────▶│ (薄客户端 ×N) │               │   dtmcpd     │
│ 其他 agent │─────────────▶│              │               │  (唯一 daemon)│
└────────────┘              └──────────────┘               │              │
                                                            └──────┬───────┘
                                                    spawn / exec   │
                                                            ┌──────▼───────┐
                                                            │     dws      │
                                                            │ (官方开源CLI) │
                                                            └──────┬───────┘
                                                                   │ 个人 OAuth 长连接
                                                            ┌──────▼───────┐
                                                            │   钉钉服务端   │
                                                            └──────────────┘
```

本机 IPC 按平台取原生机制：POSIX（macOS / Linux）用 Unix domain socket，Windows 用命名管道。端点名由 `platform/` 层解析，上层代码不认识平台分支。

**为什么薄客户端要拆出来**：MCP 客户端对 stdio server 是「每个客户端各起一个进程」。如果问答逻辑住在这个进程里，Qoder 和 Kimi 就会各自持有一个钉钉消息订阅，两个订阅者抢同一份入站消息，回复有概率落到没有那个待答问题的进程里，表现为「明明回答了 agent 却没反应」。把状态集中到唯一 daemon 是这个问题的直接解法，也顺带满足了 NFR5（单实例）和 NFR4（重启恢复）。

**多用户前提（FR11）**：这套东西会被同事各自安装。每个安装者的 daemon 只连他自己的 `dws` 登录态和自己的配置目录，推送目标必须是单人隔离会话。跨人串答（同事 B 的回话被当成同事 A 的 agent 的答案）是本项目最不能接受的一类故障。

## 2. 选型决策

### 2.1 候选方案对比

| 方案 | 接入方式 | 需要用户做的配置 | 能否接收回复 | 跨 agent | 结论 |
|---|---|---|---|---|---|
| **A 自建企业应用 + Stream SDK** | 建企业内部应用，开机器人能力，消息接收模式选 Stream，自己接 `dingtalk-stream` Node SDK | 建应用、加权限点、发布版本、拿 ClientID/Secret、（如需按钮）在卡片平台建模板 | 能 | 能 | **否** |
| **B dws + 自研编排层** ✅ | 装 `dws`，`dws auth login`，通过它的命令收发消息与事件 | 装一个 CLI、浏览器授权一次、管理员开「CLI 访问管理」 | 能（事件长连接） | 能 | **采用** |
| **C 不写代码，直接用 dws 的 skill** | 装 dws skill，让模型自己 `+dm` 发、自己 `+chat-messages` 轮询 | 同 B | 能 | 能 | **否** |

**否 A 的理由**：A 的全部额外成本来自「机器人身份」这一个选择。需求（FR1–FR9）里没有任何一条要求发送者是机器人——只需要消息能到达本人手机、回复能被读回。个人 OAuth 身份就够。A 需要用户去开放平台建应用、逐项申请权限点、发布版本、（阶段 2）还要配卡片模板，直接违反 NFR2；且 `dingtalk-stream` SDK 是 beta 版本，接口稳定性得我们自己兜。A 唯一的实质优势是按钮式卡片可控，而这属于阶段 2，届时可作为增量能力单独引入，不必在阶段 1 预付。

**否 C 的理由**：C 没有开发量，但把「等待—归属—超时—降级」这套状态机交给模型的自觉性。FR5（超时返回待答）、FR9（失败不静默）、NFR10（关闭时 ≤50ms）都无法保证，尤其 FR4「无法判定时必须追问而不是猜」——模型在多问题并发下归属回复的行为不可预测。C 只适合作为手工排错手段（直接用 dws 命令验证链路通不通），不适合作为产品形态。

### 2.2 为什么不能用其他现成 MCP（调研记录）

调研时间与来源见附录 A。结论按可信度分级：✅=读过 README/文档，◐=仅依据包描述。

| 项目 | 是什么 | 为什么不适合 |
|---|---|---|
| ✅ `open-dingtalk/dingtalk-mcp`（官方） | 钉钉 OpenAPI 的 MCP 封装：通讯录、日程、待办、机器人发消息/DING、工作通知等，按 ACTIVE_PROFILES 激活 | 只有**发送**，没有任何入站消息接收能力，无法实现 FR1 的回传。且需要自建应用与 ClientID/Secret（回到方案 A 的配置负担） |
| ✅ `DingTalk-Real-AI/dingtalk-workspace-cli`（`dws`） | 官方开源跨平台 CLI，个人 OAuth，覆盖钉钉全家桶，含 `chat` 收发与 `event` 长连接监听 | **采用**，作为传输层 |
| ◐ `@sputnicyoji/dingtalk-workspace-mcp` | dws 驱动的全量命令映射成 MCP 工具 | 它映射的是 dws 的命令面，不含问答编排语义（无 pending、无归属规则、无先到先得、无开关）。我们的价值在这一层。但它证明「dws 作为底座」这条路线成立。可作为发消息的备选实现路径 |
| ◐ `@soimy/dingtalk`、`@dingtalk-real-ai/dingtalk-connector` | OpenClaw 的钉钉 channel 插件（Stream 模式，免公网） | 需要 OpenClaw 作为 agent 宿主，与「在 Qoder/Kimi 里用」形态不符；且是双向会话镜像（阶段 4 形态），不是阻塞式问答 |
| ◐ `claude-code-dingtalk-mcp`、`dingtalk-dws-mcp` | Claude Code 的钉钉**通知**类 MCP | 通知是单向的，不接收回复；且名字里带 claude-code，绑定特定客户端，与 FR8 冲突 |
| ◐ `dingtalk-mcp`（npm 1.1.21，非官方同名包）、`@darrenyao/server-dingtalk`、`tinet-dingtalk-mcp` | 社区钉钉集成 | 描述均指向「发消息/待办/日程」，无入站接收；同名包来源不可信，不引入 |

**决策**：采用 B。`dws` 覆盖传输与鉴权，自研部分严格限制在编排语义，代码量目标是几百行而不是一个服务。

### 2.3 关键设计选择

| 选择 | 决定 | 权衡 |
|---|---|---|
| MCP server 传输 | stdio | 最普遍的客户端支持（FR8）。代价：server 进程随客户端启停，无状态；因此状态必须外置到 daemon |
| client ↔ daemon 通道 | 本机 IPC：POSIX Unix domain socket / Windows 命名管道 | 免端口冲突、免 HTTP 栈、天然本机限定、权限由文件系统或管道命名空间承载（NFR8）。代价：Windows 与 POSIX 的端点语义不同，必须收进 `platform/` 一层。放弃「只用 AF_UNIX」：它在 Windows 需 10 1803+ 且路径语义别扭，命名管道是原生选项 |
| 外部命令调用 | `spawn`，参数数组，`shell: false`，绝不拼字符串 | 拼接命令串在 Windows 上要走 `cmd.exe`，中文与引号的转义规则两头不一样（NFR13） |
| 消息正文如何传给 `dws` | 首选 `--content` 参数直传；若 D9 验证显示 Windows 下乱码，改为写 UTF-8 临时文件并按 `@file` / stdin 传入 | 中文经进程参数在 Windows 代码页下可能损坏；这条只能在 Windows 真机或 runner 上验证，不能靠推断（见 V4） |
| 配置目录 | `$DTMCP_HOME` 覆盖 → 否则 POSIX `$HOME/.dtmcp`、Windows `%APPDATA%\dtmcp` | 用平台约定而非家目录硬拼，同时保证共享开发机上按 OS 用户隔离（NFR12、FR11） |
| daemon 由谁拉起 | 薄客户端首次调用时探测 IPC 端点，不通则 detached spawn，最多等 2 秒 | 用户零操作。代价：首次提问有冷启动延迟，计入 NFR9 的 15 秒预算 |
| 单实例判定 | 直接尝试 bind IPC 端点：bind 失败且能 connect ⇒ 已有实例；三平台同一套逻辑 | 放弃 PID + flock：Windows 上文件锁语义与 POSIX 不一致，而「端口被占」在所有平台含义相同 |
| 入站消息获取 | `dws event +listen-im` 常驻子进程，读 ndjson 流 | 推送式，无需轮询，满足 NFR9。若 D5 使本人单聊不可用，退化目标为**每位使用者自己的专用会话**（每人建一个只含自己的会话并监听它），而不是多人共享的群——见 FR11 |
| 出站消息 | exec `dws chat +dm`（或 `+send-to-group`） | 每次调用一个进程，无长连接负担。关闭态提问不触发任何进程（NFR10） |
| 待答状态存储 | 单个 JSON 文件，daemon 内存为准，写时同步落盘 | 简单、可读、可人工修（NFR4）。放弃 SQLite：数据量是个位数到几十条，不值得多一层依赖 |
| 问题编号 | 全局单调递增整数 `Q1, Q2...`，落盘持久 | 手机端唯一可靠的上下文线索（FR4）。不用 UUID——人在手机上抄不进 UUID |
| 按钮式回复 | 阶段 1 不做 | 受 D7 限制。文本 + 编号已满足 FR1/FR4，且少一项用户配置 |
| 长轮询默认时长 | 45 秒 | 必须显著小于客户端工具超时。保守取 45s 而非 120s：宁可让模型多查一次，也不要被客户端切断后行为不可知 |
| 并发待答 | 不排队 | 见需求 FR4；靠归属规则兜住歧义 |

## 3. 模块划分

```
src/
  core/                 ← 纯业务，不依赖 dws、不依赖任何 agent 客户端、不读 process.platform
    question.ts         ← 问题实体与状态机
    registry.ts         ← 待答问题表、编号分配、持久化
    router.ts           ← 入站消息 → 归属判定（FR4 四条规则）
    switch.ts           ← 全局开关读写
    errors.ts           ← blocked 原因枚举
  transport/
    ding-transport.ts   ← 接口：sendText / listen / resolveTarget
    dws-transport.ts    ← 实现：exec + spawn dws
    fake-transport.ts   ← 测试实现
  platform/             ← 唯一允许出现平台分支的地方
    paths.ts            ← 配置目录、状态文件、日志、IPC 端点名
    proc.ts             ← spawn 封装（detached / 参数数组 / 无 shell / UTF-8）
    ipc.ts              ← server/client 端点抽象，POSIX socket 与 Windows pipe 同接口
    identity.ts         ← OS 用户与 DTMCP_HOME 派生的实例标识（FR11 多用户隔离）
  daemon/
    server.ts           ← IPC RPC 服务，装配 core + transport
    single-instance.ts  ← bind 探测式单实例与版本握手
  mcp/
    server.ts           ← 薄客户端：连 daemon，暴露 4 个 MCP 工具
  cli/
    index.ts            ← dtmcp on|off|status|reply|ask|init|start|stop|doctor|smoke
  adapters/             ← 阶段 2/3：客户端相关适配层，与 core 隔离
    (qoder-hooks.ts)    ← 预留，阶段 1 不创建
```

**边界规则**（这是阶段 2/3 不污染阶段 1、以及三平台不互相污染的手段）：
- `core` 不允许 import `transport`，只依赖 `DingTransport` 接口。
- `core` 与 `mcp` 不允许读 `process.platform`——平台差异由 `platform/` 消化后以参数注入。这条是跨平台不腐化的唯一防线，用一个「grep `process.platform` 只允许命中 `src/platform/`」的测试守住，不靠 code review。
- `mcp` 不允许 import `core`，只能通过 IPC 调 daemon。这强制了「多客户端共享一份状态」而不是各存各的。
- `adapters/` 是唯一允许出现某个 agent 专有概念（hook 事件名、权限回调签名）的目录。阶段 2 加进去时，`core` 和 `mcp` 不改动。

每个模块的职责、使用方式与依赖：

| 模块 | 做什么 | 怎么用它 | 依赖什么 |
|---|---|---|---|
| `core/question.ts` | 定义问题及其合法状态转换；非法转换（如已答后再答）在这里拒绝 | 构造 `Question.create({text, options, projectId, timeoutMs})`，调 `q.accept(text, source)` 返回 `AcceptResult` | 无 |
| `core/registry.ts` | 编号分配、待答索引、过期清理、落盘 | `registry.open(q)` / `registry.get(id)` / `registry.listPending()` / `registry.load()` | `question.ts` |
| `core/router.ts` | 把一条入站文本判成一个动作 | `route(text, pendingList)` → `{kind:'answer',id,text}` / `{kind:'command',cmd}` / `{kind:'ambiguous'}` | `question.ts` |
| `transport/dws-transport.ts` | 唯一与 dws 和钉钉协议打交道处 | `sendText(target,text)` / `listen(handler)` / `resolveTarget(name)` | `dws` 可执行文件 + `platform/proc` |
| `platform/paths.ts` | 从 `DTMCP_HOME` 或平台约定推出配置目录与文件路径 | `paths.home()` / `paths.state()` / `paths.ipcEndpoint()` / `paths.log()` | OS 环境变量 |
| `platform/proc.ts` | spawn 封装：参数数组、无 shell、detached、UTF-8 | `proc.run(args)` → `{code,stdout}` / `proc.spawnDetached(args)` | 无 shell 依赖（NFR13） |
| `platform/ipc.ts` | 提供三平台同名的「listen / connect」抽象 | `ipc.listen(endpoint)` / `ipc.connect(endpoint)` | POSIX socket 或 Windows pipe |
| `platform/identity.ts` | 由 OS 用户名 + 配置目录算出实例标识，用于管道名与诊断 | `identity.instanceId()` | `paths` |
| `daemon/server.ts` | 装配，持有全部状态，回答 RPC | 由 `dtmcp start` 或客户端自动拉起 | core + transport + platform |
| `mcp/server.ts` | MCP 协议 → daemon RPC 的翻译 | 写进 agent 的 mcp 配置 | daemon IPC 端点 |

## 3.5 多项目支持：独立会话架构（v1.4 修订）

### 3.5.1 问题背景

v1.3 的 Session 方案虽然解决了 IPC 连接隔离，但用户体验有问题：
- 多个项目的问题混在同一个聊天窗口
- 用户需要输入 `#Q1:` 前缀来区分回答
- 手机上看不出问题来自哪个项目

### 3.5.2 核心设计：每个项目独立会话

```
┌─────────────┐                    ┌──────────────────────┐
│  Project A  │──── ask ──────────▶│       Daemon         │
│  "官网重构"  │                    │                      │
└─────────────┘                    │  1. 查找/创建会话     │
                                   │     "官网重构问答"    │
┌─────────────┐                    │                      │
│  Project B  │──── ask ──────────▶│  2. 发送问题到该会话  │
│  "数据分析"  │                    │                      │
└─────────────┘                    │  3. 监听该会话的回复  │
                                   └──────────┬───────────┘
                                              │
                                   ┌──────────▼───────────┐
                                   │     手机钉钉          │
                                   │                      │
                                   │  ┌────────────────┐  │
                                   │  │ 官网重构问答     │  │
                                   │  │ Q: 保留备份？    │  │
                                   │  │ A: [用户回复]    │  │
                                   │  └────────────────┘  │
                                   │                      │
                                   │  ┌────────────────┐  │
                                   │  │ 数据分析问答     │  │
                                   │  │ Q: 用哪个分支？  │  │
                                   │  │ A: [用户回复]    │  │
                                   │  └────────────────┘  │
                                   └──────────────────────┘
```

**用户体验：**
- ✓ 手机上看到独立的会话，标题清晰（"官网重构问答"、"数据分析问答"）
- ✓ 直接在会话中回复，不需要 `#Q1:` 前缀
- ✓ 不会搞混哪个问题属于哪个项目
- ✓ 可以独立查看每个项目的问答历史

### 3.5.3 会话管理

```typescript
interface ProjectChat {
  projectId: string;           // 项目标识
  projectTitle: string;        // 项目标题（如"官网重构"）
  chatId: string;              // 钉钉会话 ID
  sessionId: string;           // Daemon 内部 Session ID
  questionIds: number[];       // 该项目的问题 ID 列表
  createdAt: number;
  lastActiveAt: number;
}

interface ProjectChatManager {
  // 获取或创建项目会话
  async getOrCreateChat(projectId: string, projectTitle: string): Promise<ProjectChat>;
  
  // 根据 chatId 查找项目
  getProjectByChatId(chatId: string): ProjectChat | undefined;
  
  // 列出所有项目会话
  listProjectChats(): ProjectChat[];
  
  // 关闭项目会话（可选）
  async closeChat(projectId: string): Promise<void>;
}
```

**会话命名规则：**
```
格式：{projectTitle}问答
示例：
  - "官网重构问答"
  - "数据分析问答"
  - "移动端 App问答"
  - "API 重构问答"
```

### 3.5.4 发送流程

```typescript
// daemon/server.ts

async handleAsk(params: { 
  question: string; 
  target: string;
  project_id?: string;      // 项目标识
  project_title?: string;   // 项目标题
}, socket: net.Socket) {
  // 1. 确定项目信息
  const projectId = params.project_id || 'default';
  const projectTitle = params.project_title || '默认项目';
  
  // 2. 获取或创建项目会话
  const projectChat = await this.projectChatManager.getOrCreateChat(
    projectId, 
    projectTitle
  );
  
  // 3. 分配问题 ID
  const id = this.registry.allocateId();
  const question = this.registry.add({ 
    id, 
    text: params.question, 
    target: projectChat.chatId  // 发送到项目会话
  });
  projectChat.questionIds.push(id);
  
  // 4. 发送问题到项目会话（不带 #Q1: 前缀）
  await this.transport.sendText(
    projectChat.chatId, 
    params.question  // 纯文本，如"保留备份还是删除？"
  );
  
  // 5. 记录等待
  const session = this.sessionManager.getSessionBySocket(socket);
  this.questionToSession.set(id, session);
  
  return { ok: true, status: 'pending', id };
}
```

### 3.5.5 接收流程

```typescript
// daemon/server.ts

async handleIngest(message: InboundMessage) {
  // 1. 根据消息来源找到项目
  const projectChat = this.projectChatManager.getProjectByChatId(
    message.conversationId
  );
  
  if (!projectChat) {
    return; // 不是项目会话的消息，忽略
  }
  
  // 2. 找到该项目的最新 pending 问题
  const pendingQuestion = projectChat.questionIds
    .map(id => this.registry.get(id))
    .filter(q => q && q.status === 'pending')
    .pop();  // 取最后一个
  
  if (!pendingQuestion) {
    return; // 该项目没有 pending 问题
  }
  
  // 3. 接受答案（用户直接回复文本，不需要 #Q1: 前缀）
  pendingQuestion.accept(message.text, 'phone');
  
  // 4. 通知等待的客户端
  const session = this.questionToSession.get(pendingQuestion.id);
  const waiting = this.waitingRequests.get(pendingQuestion.id);
  if (waiting) {
    waiting.resolve(message.text);
  }
}
```

**路由简化：**
- ✗ 不需要解析 `#Q1:` 前缀
- ✓ 直接根据会话 ID 定位项目
- ✓ 项目内最新 pending 问题自动获得答案

### 3.5.6 消息摄入：3 秒轮询（v1.7 修订，替代事件监听）

**为什么放弃 `dws event consume`：** 事件链路依赖 dws 的共享事件总线守护进程。实测发生过总线假死事故——总线状态自报 "connected"、消费者自报正常，但 `received` 计数 7.7 小时停在 0，手机上发的消息一条都没进来；重启 daemon 也没用（subscribe_id 是按参数确定性哈希的，重连复用同一条死订阅）。表面的"实时"建立在一条我们不可观测、不可自愈的推送链上。消息丢失对远程监控场景是致命的，因此整条替换为**轮询摄入**：可靠性和延迟都掌握在自己手里，只依赖一个可重复验证的读接口。

**摄入接口：**

```bash
dws chat +chat-messages --group <chatId> --limit 50 -f json
```

返回字段中 `messageAiSendFlag === "DWS"` 标记 Agent 自己发出的消息（第一道回声防线）。

**`daemon/chat-poller.ts` 设计：**

- 每个项目群一个 3 秒定时器，调用 `pollGroupMessages(chatId)`。
- **幂等消费（at-least-once → exactly-once 效果）**：按 `messageId` 判重，每群维护一个已见 ID 集合（容量上限 500）。
- **基线化（baseline）**：daemon 重启后的首轮只把全部历史消息 ID 记为已见，不重放历史、不给旧消息发回执。
- 跳过 `fromAgent` 消息与空内容；`onMessage` 异常只记日志，下轮继续。
- 轮询失败（dws 报错）静默容忍，下一轮自动恢复——没有需要"重连"的持久状态。

**架构原则：** 单条可靠数据路径优于"推送为主、轮询兜底"的双路径；脆弱的优化宁可删掉。延迟从 <1s 变为 ≤3s，对手机远程问答完全可接受。

### 3.5.7 MCP 工具

共 8 个工具。核心场景：Agent 提问 → 用户手机回复；以及用户外出时**主动**给项目 Agent 发消息、监控工作状态。

#### `ask_on_dingtalk`

向项目群发送问题并等待回复。

```json
// 输入（三项均必填）
{
  "question": "保留备份还是删除？",
  "project_id": "website-rewrite",
  "project_title": "官网重构"
}
```

`project_id` 隔离不同项目的问题；`project_title` 显示在钉钉群名称（`{project_title}问答`）中。首次提问时自动创建/查找群并启动轮询；`ask` RPC 同时附带调用方 `cwd`，绑定为项目工作目录（见 §3.5.10）。

#### `check_answer` / `cancel_question`

按问题 ID 查询是否已回答、或取消挂起问题。

#### `dingtalk_status`

查询推送开关状态与挂起问题数。

#### `list_projects`

```json
// 输出
{
  "projects": [
    {
      "id": "website-rewrite",
      "title": "官网重构",
      "chatId": "cidXXX",
      "pendingCount": 1,
      "createdAt": "2026-10-18T15:00:00Z"
    }
  ]
}
```

#### `read_project_messages`（新增）

读取指定项目收件箱中的未读消息，并标记为已读。用于用户在没有 pending question 时**主动**发来的消息。

```json
// 输入
{ "project_id": "website-rewrite" }

// 输出
{
  "ok": true,
  "projectId": "website-rewrite",
  "messages": [
    { "id": 1, "senderId": "user1", "content": "现在进展如何？", "timestamp": 1760000000000, "read": true }
  ]
}
```

#### `list_project_inboxes`（新增）

列出所有项目的未读消息数，供 Agent 判断哪些项目有用户主动发来的消息需要处理。

```json
// 输出
{
  "projects": [
    { "projectId": "website-rewrite", "projectTitle": "官网重构", "chatId": "cidXXX", "unreadCount": 2 }
  ]
}
```

#### `reply_to_project`（新增）

向指定项目群推送消息。**双向用途**：
1. 回答用户主动发来的收件箱消息；
2. Agent 主动推送工作状态更新（用户外出时远程监控）。

电脑端 CLI 输出保持不变，回复只推送到手机钉钉群。

```json
// 输入
{ "project_id": "website-rewrite", "content": "已完成数据库迁移，下一步重建索引。" }

// 输出
{ "ok": true, "chatId": "cidXXX" }
```

### 3.5.8 主动消息、自动确认与回显过滤

**消息路由：** 轮询收到群消息时，若该项目有 pending question，作为答案处理；否则存入项目收件箱（`inbox`，容量上限 100 条），再按 §3.5.10 的三分支路由：有活会话 → 提示"将在电脑端下一个动作时处理"（等 hook 认领）；无活会话且 `agent.headless=true` → 交给无头 Agent；无活会话且 headless 关（默认）→ 提示"该项目的 qodercli 在电脑上未启动"。项目未绑定工作目录时退化为占位回执 `已收到你的消息，Agent 稍后回复。`。

**回显过滤（echo filter）：** Agent 自己发到群里的消息会被下一轮轮询重新读到，形成 ack→收件箱→ack 的无限循环。三道防线：① 轮询侧按 `messageAiSendFlag === "DWS"` 跳过自己发的消息（§3.5.6）；② `ProjectChatManager.recordSentContent` 记录 Agent 发出的每条内容（保留最近 100 条），回流时 `wasSentByAgent` 判重忽略；③ 按 `messageId` 幂等去重，同一条消息不会被消费两次。

**持久化与接收恢复：** `ProjectChat` 映射、收件箱与工作目录（`workdir`）持久化到 `project-chats.json`；daemon 启动时 `load()`，为每个已存在的项目群自动启动轮询，重启后无需重新提问即可继续接收主动消息。

### 3.5.9 会话创建与查找

```typescript
// core/project-chat-manager.ts

class ProjectChatManager {
  private chats: Map<string, ProjectChat> = new Map();  // projectId → ProjectChat
  
  async getOrCreateChat(projectId: string, projectTitle: string): Promise<ProjectChat> {
    // 1. 查找已有会话
    const existing = this.chats.get(projectId);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }
    
    // 2. 在钉钉中查找或创建会话
    const chatName = `${projectTitle}问答`;
    let chatId = await this.findChatByName(chatName);
    
    if (!chatId) {
      chatId = await this.createChat(chatName, [currentUserId]);
    }
    
    // 3. 记录映射
    const chat: ProjectChat = {
      projectId,
      projectTitle,
      chatId,
      sessionId: crypto.randomUUID(),
      questionIds: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    };
    
    this.chats.set(projectId, chat);
    return chat;
  }
  
  private async findChatByName(name: string): Promise<string | null> {
    // dws chat +chat-list --query <name>
    const result = await proc.run([
      'dws', 'chat', '+chat-list', '--query', name, '-f', 'json'
    ]);
    const chats = JSON.parse(result.stdout);
    return chats.find(c => c.name === name)?.id || null;
  }
  
  private async createChat(name: string, members: string[]): Promise<string> {
    // dws chat +create --name <name> --members <members>
    const result = await proc.run([
      'dws', 'chat', '+create', 
      '--name', name, 
      '--members', members.join(','),
      '-f', 'json',
      '--yes'
    ]);
    const chat = JSON.parse(result.stdout);
    return chat.id;
  }
  
  getProjectByChatId(chatId: string): ProjectChat | undefined {
    return Array.from(this.chats.values()).find(c => c.chatId === chatId);
  }
}
```

### 3.5.10 手机 ↔ 电脑活会话双通道（Hook 架构）

**用户模型：** 手机钉钉是**同一个 Agent 会话的第二个输入/输出通道**（电脑终端是第一个）。开启开关后即出现两条 I/O 通道，共享同一份完整会话历史。**规则：只有项目的 qodercli 在电脑上已启动，手机才能控制和交互**；未启动 → 手机收到明确提示"该项目的 qodercli 在电脑上未启动"。

**已实测验证的前提：**
- qodercli hooks（与 Claude Code 同构）：项目级 `settings.json` 的 `hooks` 会被加载；`PostToolUse` 在真实工具边界触发，stdout JSON 的 `additionalContext` **确实进入模型上下文**（Agent 复述了注入暗号）。
- hook stdin 载荷完备：`session_id / transcript_path / cwd / hook_event_name / tool_name / tool_response`；`Stop` 事件额外带 `last_assistant_message`。

**架构：**

1. **Hook 安装器 `dtmcp install-hooks`（用户级一次性）** — `cli/install-hooks.ts`：外科手术式合并 `~/.qoder/settings.json` 的 `hooks` 键（保留其他配置与用户已有 hooks；幂等：先按命令特征清除旧 dtmcp 条目再写）。为 `SessionStart / PostToolUse(matcher *) / UserPromptSubmit / Stop / SessionEnd` 注册 `dtmcp hook`（`dtmcp` 不在 PATH 时回退 `node <abs dist/cli/index.js> hook`）。覆盖前自动备份 `settings.json.bak`。**生效需重启电脑端 CLI。**
2. **`dtmcp hook` 子命令** — `cli/hook.ts` 的 `runHook(input, rpc, env)`：读 stdin JSON → 经 daemon IPC（失败静默、绝不打断 CLI 会话）分发。环境变量 `DTMCP_HEADLESS=1`（无头 runner spawn 注入）→ 全部 no-op，防止无头会话被登记/镜像/认领（递归保护）；`DTMCP_WRAPPED=1`（`dtmcp run` 包装器注入）→ 边界 hook 跳过 `hook_poll` 认领（包装器的注入循环独占消息，防止双重消费），但保留 ping 续活与 Stop 镜像。
   - `SessionStart` → `hook_ping`（登记活会话）。
   - `SessionEnd` → `hook_leave`（注销）。
   - `PostToolUse` / `UserPromptSubmit` → `hook_ping`（续活）+ `hook_poll`（认领该 cwd 对应项目的未读手机消息）→ 有则输出 `additionalContext`："手机钉钉发来新消息（视作用户补充指令），逐条处理并在最终回复说明结果（最终回复会自动转发到手机）：\n- …"。
   - `Stop` → `hook_mirror`（把 `last_assistant_message` 推回该项目钉钉群；开关关/内容为空/是自己发的 → 不推）。
3. **活会话登记表 `daemon/session-registry.ts`** — `ping(sessionId, cwd)` upsert `{cwd, lastSeen}`；`leave(sessionId)` 删除；`isActive(cwd)` = 存在 `lastSeen < STALE_MS`（默认 2h，容忍超长工具调用；崩溃残留靠过期自愈）的记录。
4. **认领 `project-chat-manager.claimUnread(projectId)`** — 返回未读并标记已读，先到先得（多会话同目录只有一方拿到）。`getProjectByWorkdir(workdir)` 供 hook RPC 由 cwd 反查项目。

**路径规范化（实测踩坑）：** macOS 上 `/tmp` 是 `/private/tmp` 的符号链接——`process.cwd()` 可能给出链接形式，而 qodercli hook 载荷里的 cwd 是真实路径。所有 workdir/cwd 比较（`getProjectByWorkdir`、`SessionRegistry.isActive`）都经 `platform/paths.resolveDir()`（`fs.realpathSync`，路径不存在时原样返回）两侧归一化，旧持久化数据无需迁移。

**inbox 到达三分支（`server.ts` chat_message，无 pending question 时）：**
1. 有 `workdir` 且 `sessionRegistry.isActive(workdir)` → 推手机"已收到，将在电脑端 Agent 下一个动作时处理。"（等 hook 或包装器认领注入；`dtmcp run` 下 ≤2s 即执行，见 §3.5.10.2），`delivered: 'session'`。
2. 无活会话且 `headlessEnabled` 且 `agentRunner` → `enqueue` 无头处理（见下），`dispatched: 'agent'`。
3. 无活会话且 headless 关（**默认**）→ 推手机"该项目的 qodercli 在电脑上未启动，消息已存收件箱。"，`delivered: 'queued'`。
4. 无 `workdir` → 退化为占位回执（legacy ack）。

**新增 RPC：** `hook_ping / hook_leave / hook_poll / hook_ack / hook_unclaim / hook_mirror`（含 cwd 的由 daemon 反查 projectId）。

**两阶段投递（v2.1）：** `hook_poll` 认领只做**租约**（`claimedAt` 标记，60s 有效），不再直接置已读；消费者注入成功后 `hook_ack {cwd, ids}` 才落 `read`，注入失败（pty 写抛错）立即 `hook_unclaim {cwd, ids}` 归还池中；进程崩溃不 ack 则 60s 后自动可被其他消费者重认领。手机消息由此获得**至少一次**投递保证（重复仅发生在消费者崩溃且未写成的场景）。`dtmcp hook` 边界 hook 在产出 `additionalContext` 后 ack（ack 失败不阻塞输出，靠租约过期兜底）；`dtmcp run` 的 InjectionLoop 逐条注入、批尾 ack 成功项、写异常时 unclaim 剩余项。

**发送者白名单（v2.1，P0 安全）：** 群消息等价于 PC 键盘输入，`config.json` 新增 `security.allowedSenderIds: [senderId…]`。配置后：不在名单（或缺 senderId）的群消息在 `handleChatMessage` 入口直接 `ignored: 'unauthorized'`——不入收件箱、不路由答案、不回执。未配置：维持放行并在 daemon 启动日志打一次醒目告警（owner 的 senderId 即白名单唯一条目；自己的回声靠 §3.5.9 模糊匹配过滤，不受白名单影响）。

**注入时机限制（已由 §3.5.10.2 解决）：** 纯 hook 模式下消息只在**工具边界**注入活会话；会话空闲等待输入时消息滞留收件箱，直到下一次工具调用/提交提示才被认领。要"开着即随时执行"需用 `dtmcp run` 包装器启动会话。

### 3.5.10.2 `dtmcp run` PTY 包装器（v2.0：空闲活会话即时执行手机指令）

**动机（用户需求）：** "只要这个项目的 CLI 开着，无论是否空闲，都应该可以接收指令并处理，和 CLI 终端上达到相同的效果"——且不要求电脑旁有人按键。工具边界注入（§3.5.10）在空闲等待输入时无法触发，故增加键盘级注入通路。

**原理：** `dtmcp run [参数…]`（`cli/run.ts`）默认在伪终端里启动真实 qodercli；**第一个参数不是选项时即视为要包装的目标 CLI**（`dtmcp run kimi`、`dtmcp run claude`——`resolveLaunch`，注入协议对任何支持括号粘贴的 TUI 通用，与具体 agent 无关），透明双向代理按键（stdin↔pty、含 resize 转发），并常驻一个注入循环 `InjectionLoop`：每 2s `hook_ping`（续活登记）+ `hook_poll`（认领本 cwd 项目的未读手机消息），把每条消息**以人类打字的等价形式**写入 TUI 输入行——括号粘贴 + 独立回车提交。单会话转录天然连续：回到电脑前按键即可接续手机发起的工作（同一会话、同一历史，无需额外同步）。

**与 MCP 的层次关系（澄清"包装器是不是把 MCP 放外面了"）：** MCP 面始终在 agent 内部——`dtmcp mcp`（stdio server）注册进各 agent 的 mcp 配置，`ask_on_dingtalk / check_answer / read_project_messages / reply_to_project` 等全部由模型自己调用，这部分从未外置。外置的只有**唤醒/输入通路**：MCP 是 client 发起的请求-响应协议，server 无法向空闲等待输入的 agent 推送一轮对话，这是协议限制、不是设计偏好。手机→PC 的主动指令必须走 agent 外部机制：v1.9 工具边界 hook（依赖该 CLI 支持 hooks）或 v2.0 PTY 包装器（对任何 TUI 通用，等价于"远程键盘"）。两者都不是 MCP，也不该是。目标 CLI 若支持镜像类 hook（qodercli/Claude Code：`dtmcp install-hooks` 写其 settings）则回复自动回手机；不支持的 CLI 结果留电脑端转录，回电脑可接续查看。

**关键实现细节（全部实测踩坑所得）：**
- **提交必须与粘贴分离**：`\x1b[200~…\x1b[201~` 与 `\r` 在同一次 stdin 写入中被 qodercli 视为粘贴内容的一部分而**不提交**；`InjectionLoop.tick` 先写粘贴块，等待 `enterDelayMs`（默认 300ms）后单独写 `'\r'`，实测 6s 完成"投递→执行→回复→Stop 镜像"全周期。
- **长消息不走粘贴模式**：粘贴 >5 行或 >500 字符会被 TUI 折叠成 `[Pasted Text: N lines]` 占位符——`core/injector.ts` 的 `encodeTerminalInput()` 对超限消息直接逐字写入（字面模式）；消息先经 sanitize（保留 `\n\t`，剔除其余 C0/DEL 控制字符，防转义序列劫持输入解析）；`\r\n|\r` 归一化为 `\n`。
- **热车保护**：TUI 启动期（约 10s，SessionStart hooks 运行中）输入框尚未就绪，认领注入会丢失。包装器等**子进程首次渲染 + 3s 稳定窗**后才启动认领循环（`runWrapped` 的 `warmupMs`）；`InjectionLoop.stop()` 幂等且后到的 start 不再执行。
- **RPC 全容错**：`safeRequest` 吞掉一切失败（daemon 挂掉绝不能弄坏用户的终端会话），循环照常续跑。
- **认领竞争**：包装器与同项目普通 CLI 会话的边界 hook 共用 `hook_poll`，先到先得；`DTMCP_WRAPPED=1` 使被包装会话自身的 hook 不重复认领（见 §3.5.10 第 2 条）。
- **node-pty macOS 坑**：npm 解包丢失 `prebuilds/darwin-*/spawn-helper` 的可执行位 → `posix_spawnp` 失败；`package.json` 加 `postinstall: chmod +x …` 修复。

**信任边界不变：** 手机钉钉群 = 电脑键盘（同 §3.5.10.1 的声明）；包装器不做审批，注入即执行。

### 3.5.10.1 无头 Agent 处理链路（可选模式，`agent.headless=true` 才启用）

保留早期实现作为**无活会话时的代班执行者**，默认关闭。解析优先级 `env DTMCP_AGENT_HEADLESS > config.json agent.headless > false`。

**模块 `daemon/agent-runner.ts`：**

- `enqueue(project{projectId,title,chatId,workdir}, content)`，**全局串行队列**——同时最多 1 个 Agent 运行，防止 token 风暴与并发 git 冲突；处理中新到达的消息排队，逐条各得一份答复。
- 单次运行：
  1. **延迟 ack**：`ackDelayMs`（默认 15s）内完成 → 只发最终结果，无中间噪音；超过则发"收到，正在处理，完成后推送结果。"
  2. spawn `qodercli -p <消息原文> -w <workdir> --output-format json --strict-mcp-config --append-system-prompt <框架提示> [权限参数]`，注入 `env.DTMCP_HEADLESS=1`（使本次运行内的 hooks 全部 no-op）；`--strict-mcp-config` 不加载任何 MCP，杜绝无头 Agent 反向调用 dingtalk 工具造成递归。
  3. 解析 stdout 中 `type === "result"` 的行：成功 → 推送 `result`（超 `maxLen` 截断并加"…（已截断，详见电脑端）"）；`is_error` 或解析失败 → 推送"处理失败：<摘要>"。
  4. 超时（默认 15 分钟）→ kill 子进程并推送"处理超时，请在电脑端查看"。
- runner 发出的所有文本经 `recordSentContent` 登记，与 §3.5.8 回显过滤双保险。
- daemon `stop()` 时清空队列、kill 当前子进程，且被 kill 的运行**不再投递结果**。

**权限模式（可配置，默认完全自主）：** 解析优先级 `option > env DTMCP_AGENT_PERMISSION_MODE > config.json agent.permissionMode > 'full'`。`full`=`--dangerously-skip-permissions`，`read-only`=`--tools read grep glob`，`accept-edits`=`--permission-mode accept_edits`。

信任边界：无论活会话还是无头模式，手机钉钉群都等于电脑被执行入口；账号/群泄露即电脑被操控（用户已知晓并选择）。

**工作目录绑定：** 薄客户端（`mcp/mcp-server.ts`）在 `ask` RPC 中自动附带 `cwd: process.cwd()`；daemon 侧 `handleProjectAsk` 每次提问将 cwd 写入 `ProjectChat.workdir`（后续提问可重绑），随 `project-chats.json` 持久化。双通道认领与无头执行都以此为键。

### 3.5.11 模块更新

新增模块：
```
src/
  core/
    project-chat-manager.ts  ← 项目会话管理（含收件箱、workdir 绑定、claimUnread、回声登记）
    injector.ts              ← 终端注入编码内核（括号粘贴/字面分流、sanitize、CRLF 归一）
  daemon/
    chat-poller.ts           ← 3 秒轮询摄入（messageId 幂等、基线化、fromAgent 过滤）
    agent-runner.ts          ← 无头 Agent 处理链路（可选模式：串行队列、延迟 ack、超时、权限模式、DTMCP_HEADLESS）
    session-registry.ts      ← 活会话登记表（ping/leave/isActive、2h 过期自愈）
  cli/
    hook.ts                  ← dtmcp hook：stdin JSON → IPC 分发（注入 additionalContext / Stop 镜像 / DTMCP_HEADLESS 短路 / DTMCP_WRAPPED 免认领）
    install-hooks.ts         ← settings.json hooks 键外科手术合并（幂等、备份、保留用户配置）
    run.ts                   ← dtmcp run：node-pty 包装器 + InjectionLoop（2s 轮询认领、粘贴+分离回车、热车窗、RPC 容错）
```

更新模块：
```
daemon/server.ts             ← 持有 ProjectChatManager + SessionRegistry + headlessEnabled；chat_message 三分支路由；hook_ping/leave/poll/mirror RPC
daemon/index.ts              ← 构造 runner 与 poller，随消息生命周期接线
transport/dws-transport.ts   ← pollGroupMessages（dws chat +chat-messages）
mcp/mcp-server.ts            ← ask 工具新增 project_id/project_title，RPC 附带 cwd
```

### 3.5.12 向后兼容

- 不传 `project_id` / `project_title` → 使用默认项目"默认项目问答"
- 单项目场景 → 行为与 v1.3 相同（只有一个会话）
- `project-chats.json` 旧文件缺 `workdir` / `inbox` 字段 → `load()` 容忍，缺省 undefined / 空数组

### 3.5.13 实施计划

**阶段 1（已完成）：项目会话管理 + 轮询摄入 + 无头处理**
- 实现 `ProjectChatManager`
- 实现 `ChatPoller` 轮询摄入（替代事件监听，见 §3.5.6）
- 实现 `AgentRunner` 无头处理链路与 workdir 绑定（见 §3.5.10）
- 更新 MCP 工具接口

**阶段 2：可靠性增强**
- 添加超时机制（问题 45 秒未回答自动 expire）
- 添加会话自动清理（30 天不活跃）

**阶段 3：UX 增强**
- 项目标题智能推断（从 git remote / package.json）
- 会话历史记录查询

### 3.5.14 与 v1.3 的对比

| 方面 | v1.3 | v1.4（本版本） | 收益 |
|------|------|----------------|------|
| 消息格式 | `#Q1: 内容` | 纯文本 `内容` | 用户不需要输入前缀 |
| 会话结构 | 单一聊天窗口 | 每个项目独立会话 | 清晰隔离，不会混淆 |
| 路由依据 | Question ID + Session | 会话 ID → 项目 | 更自然 |
| 用户体验 | 需要记住格式 | 直接回复 | 更简单 |
| 复杂度 | ~100 行 | ~200 行 | 增加 100 行，换取更好 UX |

## 4. 接口契约

## 4. 接口契约

### 4.1 MCP 工具

#### `ask_on_dingtalk`
输入：
```json
{
  "question": "string，必填，问题正文，≤500 字符",
  "options": ["string"]，选填，候选项，≤6 项，会编号 1..n 呈现
  "timeout_seconds": "number，选填，默认 45，范围 5–300",
  "context": "string，选填，附加上下文；默认不发送，见 NFR7"
}
```
输出（`status` 是唯一分流依据，四个分支互斥）：
```json
{ "status": "answered",  "question_id": 3, "answer": "保留备份", "answered_via": "phone|terminal", "elapsed_ms": 18422 }
{ "status": "pending",   "question_id": 3, "hint": "人尚未回复，可继续其他工作，之后调用 check_answer(3)" }
{ "status": "disabled",  "hint": "推送已关闭，请使用本地提问方式" }
{ "status": "blocked",   "reason": "not_logged_in|target_unresolved|listen_disconnected|daemon_unavailable|send_failed", "detail": "...", "hint": "..." }
```

`answered_via` 是需求 G3 的可见证据，必须返回，不能省略——agent 需要知道答案是从手机来的还是同事在终端帮答的（措辞上「谁答的」影响后续信任度）。

#### `check_answer`
输入 `{ "question_id": number }`
输出 `{ "status": "answered|pending|expired|cancelled|unknown", "answer"?, "answered_via"? }`

#### `cancel_question`
输入 `{ "question_id": number, "reason"?: string }`
输出 `{ "status": "cancelled|already_resolved|unknown" }`
副作用：向手机发一条短消息「Q3 已作废：<reason>」，让人知道不用再答。

#### `dingtalk_status`
输入 `{}`
输出：
```json
{
  "enabled": true,
  "platform": { "os": "darwin|win32|linux", "node": "20.11.0", "ipc": "unix_socket|named_pipe", "config_dir": "..." },
  "dws": { "available": true, "version": "...", "logged_in": true, "profile": "corpId:userId", "identity_display": "张某某 @ 某公司" },
  "target": { "resolved": true, "type": "self_dm|personal_conversation", "display": "...", "owned_by": "本人" },
  "listener": { "connected": true, "restarts": 0, "last_error": null },
  "pending": [{ "id": 3, "project": "dingtalk-mcp", "asked_seconds_ago": 41 }]
}
```
这个工具是 FR7 的实现。它必须能区分「开关关着」「没登录」「监听断了」「已推送但没人回」，因此四个字段各自独立，不合并成一个健康布尔值。

`dws.identity_display` 与 `target.owned_by` 是为 FR11 服务的：同事装完后最担心的是「我是不是在往别人的会话发消息 / 我登的是不是工作账号」。这两个字段把身份摆到台面上，比在 README 里写一句「请确认你的账号」有效。`platform.ipc` 暴露实际使用的 IPC 机制，Windows 排错时这是第一个要看的东西（D8）。

### 4.2 daemon IPC RPC

换行分隔 JSON（NDJSON），一行一请求一行一响应。不用 HTTP：没有多资源、不需要 REST 语义，IPC + NDJSON 少了整套 HTTP 依赖。端点由 `platform/ipc` 解析，POSIX 是 socket 文件、Windows 是命名管道名，两种都带 `instanceId` 以保证共享开发机上多用户互不干扰。

请求：`{"id":1,"method":"ask","params":{...}}`
响应：`{"id":1,"result":{...}}` 或 `{"id":1,"error":{"code":"...","message":"..."}}`

方法集合与 MCP 工具对应（`ask` / `check` / `cancel` / `status` / `list_projects` / `read_project_messages` / `list_project_inboxes` / `reply_to_project` / `reply` / `set_switch`），外加内部方法：`hello`（版本握手，客户端据此判断能否 `{"method":"spawn"}` 自行拉起 daemon）、`ingest`（transport 把入站消息喂进 core）、`chat_message`（轮询回流，路由答案、写入收件箱并按三分支处理，见 §3.5.8、§3.5.10）、`hook_ping` / `hook_leave` / `hook_poll` / `hook_ack` / `hook_unclaim` / `hook_mirror`（`dtmcp hook` 子命令使用：活会话登记/注销、认领/确认/归还未读手机消息、Stop 最终回复镜像回手机；`dtmcp run` 的 InjectionLoop 同样复用这些方法，不另新增）。**响应封装（v2.1）：** socket 层响应一律 `{ ...result, id: request.id }`——`id` 永远是 JSON-RPC 关联 id，业务 id 以 `questionId` 等具名字段返回（此前业务 `id` 会覆盖关联 id 导致客户端挂死，属 P0 修复）。

这是有意的分层——MCP 面只暴露 agent 需要的动作，其余（`hello`/`spawn`/`ingest`/`chat_message`/`set_switch`）留在本机或由 daemon 内部调用。

### 4.3 CLI 命令

```
dtmcp version                    # 打印版本号（v0.1.2 起，另支持 --version / -v）
dtmcp doctor                     # 前置条件全量自检（FR10），未通过项给下一步动作
dtmcp init [--target <名称>]     # 解析并持久化本人专属目标会话（D5/FR11 的落地处）
dtmcp on | off | status          # 开关
dtmcp ask "问题" [选项...]        # 手动发一条（调试）；长文本用 --file 或 stdin
dtmcp reply <id> <文本>           # 电脑端作答（G3）
dtmcp pending                    # 列待答
dtmcp start | stop | logs        # daemon 生命周期
dtmcp smoke                      # 真机冒烟：登录 → 目标 → 发一条 → 等回复
dtmcp install-hooks              # 一次性注册 dtmcp hooks 到 ~/.qoder/settings.json
dtmcp hook                       # qodercli hook 子进程入口（内部使用）
dtmcp run [qodercli 参数…]        # PTY 包装启动 qodercli：手机指令空闲也即时提交执行（§3.5.10.2）
```

> **实现状态（v2.6）**：实际提供 `version / doctor / status / on / off / pending / daemon / mcp / hook / install-hooks / run`。上面规划中的 `init`、`ask`、`reply`、`start/stop/logs`、`smoke` 未实现——目标会话改为**按项目自动创建**：首次 MCP `ask_on_dingtalk` 或 `dtmcp run` 的 `hook_register` 触发 `getOrCreateChat`（见 v2.2）。`doctor --format json` 亦未实现，当前输出为人读文本。README 的安装后步骤已按实际命令改写。

`dtmcp doctor` 的输出格式要求是**机器可读优先**（`--format json`），人类可读视图由它渲染。理由：同事排错时最常见动作是把这段输出贴给你，一份纯文本描述无法被自动比对，而 JSON 可以直接进 issue。

`dtmcp ask` 提供 `--file` / stdin 入口不是为 convenience：这是 D9（Windows 参数编码）验证失败时唯一不改架构的通路，早一个参数比晚动手便宜。

## 5. 数据模型与状态机

### 5.1 Question 状态机

```
            ┌──────────────┐
            │    draft     │  构造完成，尚未发送
            └──────┬───────┘
                   │ send 成功
        ┌──────────┼──────────────┐
        ▼          ▼              ▼
   ┌────────┐  ┌────────┐   ┌─────────┐
   │ pending│  │blocked │   │disabled │   终态
   └───┬────┘  └────────┘   └─────────┘
       │
   ┌───┼─────────────┬──────────────┐
   ▼   ▼             ▼              ▼
answered        expired        cancelled
```

`blocked` / `disabled` 在创建时即判定，不进入 pending（不存在「已推送」）。**`pending` 的唯一进入条件是 `dws` 发送成功返回**——这条不变式是 FR9「失败不静默」的实现来源：状态里没有「可能发了」这种模糊档位，只有确定的发送成功或确定失败。

转换规则（`core/question.ts` 强制）：
- `pending → answered` 是**单向、恰好一次**。第二次尝试返回 `already_resolved`，携带既有答案，绝不覆盖（G3 先到先得）。
- `answered` / `expired` / `cancelled` 是终态，任何入站消息都不再改变它。
- `expired` 由 daemon 在 `asked_at + ttl` 后置触发，`ttl` 默认 30 分钟（远大于长轮询时长，让人有几分钟后回来答的机会）。

### 5.2 持久化文件

配置目录：`$DTMCP_HOME`，未设置时 POSIX 取 `$HOME/.dtmcp`、Windows 取 `%APPDATA%\dtmcp`。目录内权限 0700（Windows 靠 `%APPDATA%` 本身的用户隔离，见 §8）。

```
state.json          # 问题正文与开关状态
daemon.log          # 轮转上限 5MB
（IPC 端点：POSIX 为目录内 dtmcp.sock；Windows 为命名管道，名含 instanceId，不落文件）
```

POSIX 下 daemon 的运行期文件权限为 0600；Windows 下命名管道不存在权限位，靠管道名里的 `instanceId`（OS 用户名 + 配置目录哈希）避免与其他用户撞名。

`state.json`：
```json
{
  "version": 1,
  "enabled": true,
  "next_id": 4,
  "target": { "type": "self_dm", "display": "自己", "resolved_at": "..." },
  "ttl_ms": 1800000,
  "questions": [
    {
      "id": 3,
      "text": "旧配置文件是删掉还是保留备份",
      "options": ["删除", "保留备份"],
      "project": "dingtalk-mcp",
      "session": "qoder",
      "status": "pending",
      "asked_at": 1760000000000,
      "answer": null,
      "answered_via": null,
      "context_opt_in": false
    }
  ]
}
```

写入策略：每次状态变更后同步全量写（数据量小，全量写比增量安全：崩溃时最坏是丢最后一条变更，而不是产生半截索引）。临时文件 + rename，避免写坏。

`session` 字段（哪个 agent 发起的）为阶段 4 预留：远程控制需要知道「把回复送回哪个会话」，但阶段 1 用不到。存了不用是刻意的，成本一个字段。

## 6. 关键流程

### 6.1 提问与回答（主流程）

```
agent          mcp薄客户端        daemon              dws           手机
  │ ask_on_dingtalk │               │                  │             │
  ├────────────────▶│ ask          │                  │             │
  │                 ├──────────────▶│                  │             │
  │                 │               │ 读开关            │             │
  │                 │               │ off → 返回 disabled（无网络调用）│
  │                 │               │ on ↓              │             │
  │                 │               │ 分配 Q3，status=draft          │
  │                 │               ├── exec +dm ─────▶│             │
  │                 │               │   成功           ├── 推送 ────▶│
  │                 │               │   status=pending，落盘          │
  │                 │               │ 长轮询等待（≤45s）│  ←─ 监听子进程读 ndjson
  │   手机：                「#Q3: 保留备份」          │             │
  │                 │               │◀─ ingest ─────────┤◀───────────┤
  │                 │               │ router: 规则2 → Q3            │
  │                 │               │ Q3 → answered(phone)          │
  │                 │               │ 发短确认「已收到：保留备份」───▶│
  │◀── answered ─────┤◀──────────────┤                  │             │
  │ 继续工作          │               │                  │             │
```

要点：
1. 开关关闭时链路在第 2 步结束，零网络调用（NFR10）。
2. **长轮询不轮询 dws**。入站消息来自常驻 `dws event +listen-im` 子进程的 stdout 流；`ask` 只是在 daemon 内等待一个由该流触发的 promise。这样提问等待期间的开销与消息延迟解耦（NFR9）。
3. 答完发一条确认短消息，让人明确知道「agent 已经收到」，不用猜。这条消息必须极短，避免刷屏。

### 6.2 两端先到先得

```
电脑端: dtmcp reply 3 "保留备份"
   → daemon accept(text, source=terminal)
   → 若 Q3 仍 pending: 记 answered(terminal)
       → 往手机发「Q3 已由电脑端回答：保留备份」→ 人不会再重复答
   → 若 Q3 已 answered: 返回 already_resolved + 既有答案，不覆盖
```
反向（手机先答、随后有人在终端敲 reply）走同一份判定，对称。

> **实现状态（v2.7）**：`dtmcp reply` CLI 未实现，阶段 1 只能从手机作答；daemon 内的 `reply` RPC 与"先到先得"判定已就绪，后续补 CLI 入口即可。

### 6.3 手机端切开关

daemon 收到每条入站消息，**先过 router 的指令分支再过答案分支**：

```
"#关"    → set_switch(false) → 回复「已关闭推送」→ 绝不进入答案归属判定
"#开"    → set_switch(true)  → 回复「已开启推送」
"#忽略3" → cancel_question(3)
"#Q3: 用方案B"  → 规则2 定向
```

歧义处理：存在待答问题时发来一条 `#关` 之外又不带编号的短消息，且 pending 数 > 1 → 走规则 4，回一条「有 2 个问题待答，请用 `#Q3: 你的回答`」并附当前问题摘要。宁可多一轮往返，不可猜错——猜错意味着把 A 项目的决定应用到 B 项目。

### 6.4 归属规则的实现顺序

规则顺序写在 `core/router.ts`，是纯函数：`(文本, pendingList) → 判定`。它是整个项目最需要单测的一段（覆盖见 §9）。判定所用的 pendingList 是**只读快照**，router 不改变状态，副作用全在 daemon——保证 router 可独立测试。

## 7. 可靠性

| 场景 | 处理 |
|---|---|
| 监听子进程退出 | daemon 重启它，指数退避 1s/2s/4s…上限 60s，重启计数进 `dingtalk_status.listener.restarts`。**待答问题不受影响**（它们已落盘，人随时能答） |
| 提问期间监听断开 | `ask` 仍返回 pending，不返回 blocked——消息已送达，只是暂时收不到回复。这个区分很重要，若误报 blocked，agent 会重复发送同一问题，手机上出现两条相同提问 |
| daemon 崩溃/重启 | 启动时 `registry.load()` 恢复 pending 与 `next_id`；对每个 pending 检查是否已过 `ttl`，过期即置 expired 并（可选）通知 |
| 多个 daemon 竞争 | bind IPC 端点为准：bind 成功即为持有者；bind 失败且能 connect 说明已有实例，做 `hello` 版本握手后复用。三平台同一套判定，不用 PID + 文件锁（Windows 文件锁语义与 POSIX 不同，而「端点已占用」在两头含义一致）。版本不匹配必须显式报错要求重启，不静默兼容——旧 daemon 与新客户端协议不一致时，最坏表现是问题被旧 daemon 接走而新语义（如 `answered_via`）永远不出现 |
| 中文正文在 Windows 下损坏 | `platform/proc` 统一 `shell: false` + 参数数组 + 显式 UTF-8。若 V4 验证失败，发送改走临时文件，通过 `dws` 的文件入参或 stdin 传入；`core` 与 daemon 都不感知，改一个文件 |
| 客户端首次调用而 daemon 未起 | `mcp/server.ts` 尝试连 IPC 端点，失败 → detached spawn + 最多 2 秒等待 → 仍失败返回 `blocked(daemon_unavailable)` |
| dws 升级改命令/字段 | 所有 dws 调用集中在 `dws-transport.ts` 一个文件。dws 的 skill 文档明确要求「按真实返回判断，不猜字段」，本实现遵循：解析失败记 `transport_schema_drift`，不降级为「当成没收到」 |
| 人在提问后回到电脑想本地答 | 已覆盖（6.2）。`dtmcp pending` 列出待答，无需记编号 |

## 8. 安全与隐私

推送到手机的消息会经过钉钉服务端并持久化在聊天记录里，因此默认最小化外传内容：

- 消息正文只含：`【dingtalk-mcp · <项目名> · Q<id>】` + 问题文本 + 编号候选项。
- **`context` 参数默认不发送**，即使 agent 填了。要发必须显式 `context_opt_in`，且在 daemon 日志里留下这条决定（可审计）。这条限制来自 NFR7，理由：模型很容易把整段报错栈、文件路径、甚至配置片段塞进问题正文，其中可能含内部主机名或密钥。
- 输入校验：问题文本 > 500 字符时**截断并标注**，同时在 MCP 结果里提示 agent「正文过长，已截断，请精简或改本地提问」。不是拒绝，也不是全量发。
- 不记录：ClientID/Secret、OAuth token、refresh token、`dws` 输出里的任何凭证字段。日志只记命令名与退出码，不记 `dws` 的原始 stdout（其消息正文可能含用户输入内容，且我们不需要）。
- 文件权限：POSIX 下目录 0700、文件与 socket 0600（NFR8）。Windows 下依赖 `%APPDATA%` 的用户级隔离与命名管道的名字唯一性；这是**需要在 Windows runner 上实测的假设**，不写进「已成立」。
- `state.json` 里的问题文本会落盘。这是必要的（重启恢复），但要写进 README：机器上其他用户读不到，备份/同步这个目录等于同步聊天记录。

### 8.1 多使用者之间的隔离（FR11）

同事各自安装时，串号的代价比单机高得多：A 的 agent 拿到 B 的回话，等于把 B 的判断当成 A 项目的决定。三层各自独立保证隔离：

1. **传输隔离**：每位使用者用**自己的** `dws` OAuth 登录态，消息目的地是其本人会话。不存在共享 endpoint。
2. **目标隔离**：`dtmcp init` 解析出的 target 存在**本地配置目录**里，永不写进仓库；`V1`/`D5` 的退化方案也必须是「每人一个私人会话」，禁止多人共享群。
3. **进程隔离**：IPC 端点名含 `instanceId`（OS 用户名 + 配置目录哈希），共享开发机上两个账号不会连到同一个 daemon。

`target.owned_by` 与 `dws.identity_display` 把前两条做成可见的，`dtmcp doctor` 里给结论。

### 8.2 需要在使用者知情后才推送的内容

问题正文经钉钉服务端投递，并长期留在使用者自己的聊天记录里。内容里可能含内部项目名、模块名、报错摘要。因此：默认只推问题文本 + 项目标识（NFR7），且 README 必须明确写出这一条，让每位同事自己判断是否可接受。不把它藏在配置默认值后面。

## 9. 测试策略

| 层 | 覆盖 | 方式 |
|---|---|---|
| 单元（`core/router`） | FR4 四条规则全分支：指令优先于答案、带编号定向、唯一 pending 自动归属、多 pending 无编号 → ambiguous、`#忽略` | 纯函数测试，无需 mock |
| 单元（`core/question`） | 状态机不变式：pending 只能由发送成功进入；二次回答被拒且返回既有答案；终态不可变 | 表驱动测试 |
| 单元（`core/switch`） | 关闭态短路、持久化后重启保持、`#关`/`#开` 生效 | 临时目录 |
| 集成（daemon + `FakeTransport`） | 6.1 全链路（假传输注入入站消息）、6.2 先到先得两方向、6.4 超时返回 pending 后答案仍可回查、监听重启后 pending 存活 | 起真实 socket server 在临时 socket |
| 契约测试（`DwsTransport`） | 对 dws 输出结构的解析：给固定 fixture（真实 dws 输出的脱敏样本），断言解析；字段缺失时报 drift 而非静默 | fixture |
| 平台层（`platform/`） | 路径推导（含 `DTMCP_HOME` 覆盖、Windows `%APPDATA%`）、IPC 端点名生成、spawn 参数数组不经过 shell、含中文/引号/换行/emoji 的正文往返一致 | CI 三平台矩阵跑同一套断言 |
| 多用户隔离（FR11） | 用两个不同 `DTMCP_HOME` 起两个 daemon 实例，断言 IPC 端点、状态文件、pending 表互不干扰 | CI，无需真实钉钉 |
| 离线自检（FR10） | `dtmcp doctor --format json` 在缺 dws / 缺登录 / 目标未解析三种环境下分别给出正确 verdict 与下一步提示 | CI，用 stub PATH 与临时目录 |
| 真机冒烟 | `dtmcp smoke`：登录态 → 目标可解析 → 手机收到 → 人回复 → 结果返回；每一步打印明确成功/阻塞 | 人工执行，阶段 1 退出前必须跑通；macOS 与 Windows 各一次 |
| 端到端（客户端） | 在 Qoder 里配好 MCP，让 agent 真的提一次问；在 Kimi 里重复（FR8） | 人工 |
| 同事验收 | 一位同事照 README 从零装完并跑通冒烟，全程不向你求助（需求 §9 可移交指标） | 人工 |

CI 矩阵：GitHub Actions，`[macos-latest, windows-latest, ubuntu-latest] × [Node 20, Node 22]`。单元、集成、平台层、隔离、doctor 离线检查全部进 CI；凡需要真人手机作答的分支一律不进 CI（否则必然是个天天跳过或被删掉的测试）。

`FakeTransport` 是这套测试成立的前提：它让「人何时回复」在测试里可控，包括「先答两次」「答得极慢」「dws 发送失败」这些真实场景下很难复现的分支。

## 10. 分阶段实现路线

### 阶段 1（本期，即需求 FR1–FR12）
1. 仓库脚手架：`package.json`（ESM、`engines: >=20`、bin `dtmcp`）、tsconfig、vitest、`.github/workflows/ci.yml` 三平台矩阵、LICENSE、README 骨架
2. `platform/`：paths / proc / ipc / identity —— 先于业务层，因为后面每个模块都要用它
3. V2、V3 验证（§12），确定 `DwsTransport.listen` 的入站字段结构
4. `core` 五个模块 + 单测（先写测试再写实现；router 与状态机是重点）
5. `DingTransport` 接口与 `FakeTransport`
6. `daemon` + IPC RPC + bind 式单实例 + 版本握手
7. `mcp/server.ts` 四个工具
8. `cli`：`init/on/off/status/reply/pending/start/stop/doctor/smoke`
9. 集成测试、平台层与隔离测试进 CI
10. macOS 真机冒烟 → Qoder 端到端 → Kimi 端到端（FR8）
11. Windows：先验 V4/V5，再跑一次真机冒烟
12. 请一位同事照 README 独立装一遍（需求 §9 可移交指标）

### 阶段 2 的预留点
- `Question` 加 `kind: 'ask' | 'approval'`，approval 携带 `tool_name`、`args_digest`、`dangerous: boolean`。归属、先到先得、超时、状态机全部复用——**审批本质上就是「答案域为 approve/deny 的问题」**。
- `adapters/qoder-hooks.ts`：把客户端 hook 事件转成 `kind=approval` 的 ask 调用。这是唯一含客户端专有概念的目录。
- 若届时需要按钮而非打字：单独引入方案 A 的卡片能力（建应用 + 卡片模板），作为 `DingTransport` 的第二个实现 `DingTalkBotTransport`。`core` 无感。
- **不做**：现在就写 hook 适配的骨架。需求未定，写了就是废码。

### 阶段 3 的预留点
单向通知复用 `sendText`，新增 `notify(level, text)` RPC 与 MCP 工具；`Question` 不参与（无回复期待），因此不扩状态机。

### 阶段 4 的预留点
入站消息的 router 增加 `kind: 'command'` 分支，把「新任务」类文本交给一个反向通道；`state.json` 的 `session` 字段届时启用。当前只保证「加了字段不破坏现有解析」，不实现。

## 11. 备选与放弃的方案

| 备选 | 为什么放弃 |
|---|---|
| 把问答逻辑直接放进 MCP server 进程，不要 daemon | 每个 agent 各起一个进程 → 多订阅者抢入站消息（§1 的核心问题），且无跨客户端开关状态。省掉一层 socket，换来一个偶发且难排查的丢回复 bug，不值 |
| daemon 用 HTTP 而非 Unix socket | 需要端口分配、端口冲突处理、以及本机访问控制（除非上 TLS）。HTTP 的唯一收益是远程 daemon，而远程 daemon 不是本期目标 |
| 每个问题轮询 `dws chat +chat-messages` | 引入轮询间隔与 API 频控调参负担，延迟不可控（NFR9）。事件流已可用，无必要 |
| SQLite 存状态 | 数据量个位数，多一个依赖与一层 schema 迁移负担 |
| 无限等待直到人回复 | 会被 MCP 客户端工具超时切断，切断后 agent 行为不可预测（可能重复提问）。见需求 FR5 决策 |
| 并发提问串行排队 | 违反 FR4。多项目并行时人为加锁 |
| 群自定义 webhook 机器人（`ROBOT_ACCESS_TOKEN`）发送 | webhook 机器人只能发不能收，FR1 回传无法实现 |
| 独立二进制（bun compile / pkg） | 三平台交叉编译还要各自处理签名：macOS 不公证 Gatekeeper 就拦，Windows 无签名触 SmartScreen。装 coding agent 的人已有 Node，收益抵不上发布负担 |
| 多人共享一个群作为推送目标 | 同事 B 在群里回一句话会被同事 A 的 agent 当成答案，违反 FR11。目标必须单人隔离 |
| PID 文件 + 文件锁做单实例 | Windows 文件锁语义与 POSIX 不同，跨平台不可依赖；bind IPC 端点在两头含义一致 |
| 开机自启（launchd / Windows 服务 / systemd） | 三平台各一套注册机制与权限提示，而首次调用按需拉起已满足需求。见需求「非目标」 |

## 12. 开放问题与前置验证

必须在写第一行实现代码之前用真实 dws 验证。

| # | 待验证 | 影响的决策 | 状态 | 若失败 |
|---|---|---|---|---|
| V1 | `dws chat +dm --to <本人姓名>` 能否把消息发给自己 | `target.type`；FR1 消息形态 | **已通过**（2026-10-18，macOS） | 退化目标为每人自己的私人会话，禁止共享群（FR11） |
| V1b | `dws auth login` 与安装脚本可用 | 附录 B 的准备步骤 | **已通过**（macOS） | Windows 侧另需 `install.ps1` + `--device` 登录验证 |
| V2 | `dws event +listen-im --kind all-direct` 是否实时收到发给本人的单聊消息；入站结构里发送者、正文、会话 ID 的真实字段名 | `DwsTransport.listen` 的实现；§6.1 推送式接收 | **已验证后弃用**：`+listen-im` 不工作；`event consume` 可用但共享总线存在假死（自报 connected、received 恒 0、重启复用死订阅），消息丢失不可接受 | 已按预案退化为 `+chat-messages` 3 秒轮询（§3.5.6），摄入链路不再有持久连接状态 |
| V3 | 同一账号两个 `dws event consume` 订阅同一 EventKey 是 fan-out 还是互抢 | NFR5 单实例是建议还是硬约束 | **不再关键**：摄入已不依赖事件订阅；subscribe_id 为参数确定性哈希，重启复用同订阅 | 单 daemon 架构保留（跨客户端开关状态同样必需） |
| V4 | 中文正文经 Windows 进程参数传给 `dws` 是否乱码 | 发送是否需改走临时文件/stdin（D9） | **待验证**（需 Windows 机器或 CI runner） | 临时文件通路已作为 `dtmcp ask --file` 预留，改一个文件 |
| V5 | Windows 上 `%APPDATA%` 隔离与命名管道名唯一性是否成立；`platform/paths` 的 Windows 分支 | NFR8、FR11 第 3 层 | **待验证**（CI 可覆盖路径推导，端到端需真机） | 端点名追加 PID 或哈希后缀，或改回 AF_UNIX（Win10 1803+） |

另外三项待核对，不阻塞阶段 1：

- `dws event` 的订阅是否需要显式 stop 清理（`dtmcp stop` 时若遗留订阅，下次 `dws event status` 会看到僵尸订阅）
- 长轮询 45 秒与各家 MCP 客户端工具超时默认值的具体关系，需要在 Qoder 和 Kimi 各测一次实际切断时间
- 同事所在组织若未开 CLI 访问，`dws` 的报错原文长什么样——`doctor` 要把它翻译成人话（D10）

## 13. 分发与仓库形态

| 项 | 决定 |
|---|---|
| 包名 | `dtmcp`（npm），命令同名；bin 提供 `dtmcp` |
| 安装 | `npm i -g dtmcp` 或零安装 `npx -y dtmcp mcp` 直接写进 agent 配置（NFR16）。**实现状态**：尚未发布 npm，`npm i -g dtmcp` / `npx -y dtmcp` 均不可用；当前从 GitHub tag 安装（Windows 用 archive tarball、macOS/Linux 用 git 依赖），命令见 README「Install dtmcp」 |
| `engines` | Node `>=20` |
| 模块格式 | ESM；MCP SDK 与 CLI 入口都用 ESM，避免 CJS/ESM 双构建 |
| 对外入口 | `dtmcp mcp`（给 agent 配置）、`dtmcp`（人用 CLI）、`dtmcp daemon`（内部，由前两者调用） |
| 仓库根 | `README.md`（中文为主 + English 摘要）、`LICENSE`（Apache-2.0）、`docs/`（本两份文档）、`.github/workflows/ci.yml`（三平台矩阵）、`src/`、`package.json`、`.gitignore` |
| README 必含 | 前置条件三件事（Node、dws 安装、组织 CLI 访问需管理员开一次）、6 步上手、`doctor` 输出示例、**「问题正文会进入你的钉钉聊天记录」的知情说明**、四阶段路线与当前所处阶段 |
| 版本策略 | 语义化版本；daemon IPC 协议带 `version` 与 `hello` 握手，daemon 与客户端版本不匹配必须显式失败 |

「别人也能装」这条对代码的唯一实质要求：**任何机器相关值都不得写进源码**。项目名、姓名、userId、群 ID 一律来自安装者本地的 `dtmcp init` 结果或运行时解析。

## 附录 A：调研到的 dws 能力清单（本项目用到的部分）

```
dws auth login                          # OAuth 设备流/浏览器登录（用户手动执行）
dws chat +dm --to <姓名> --content <文本>      # 以本人身份发单聊
dws chat +send-to-group --group <群> --content <文本>
dws chat +messages-send-card --receiver <...> --content <文本>   # 流式卡片（本期不用）
dws chat +chat-messages --group <cid> --start <ISO> --end <ISO> --format json  # 读历史（V2 失败时的退路）
dws event +listen-im --kind all-direct --flatten -f ndjson   # 实时入站消息
dws event status / dws event stop <subscribe_id>
dws event consume user_card_action_triggered   # 卡片交互回调（阶段 2 备选）
```

依据：仓库 `DingTalk-Real-AI/dingtalk-workspace-cli` 的 `docs/command-index.md` 与 `skills/multi/dingtalk-chat`、`skills/multi/dingtalk-event`。

## 附录 B：使用者一次性准备

**组织级，管理员做一次，全公司受益（D10）**

1. 开发者后台 →「CLI 访问管理」→ 开启。同事接入失败的第一大原因，README 顶部要写。

**个人级，每位使用者各自做**

0. 装 Node.js ≥ 20（dtmcp 是 Node CLI，MCP server 也靠 node 起）。Windows：`winget install OpenJS.NodeJS.LTS` 后**新开终端**生效；qodercli/Kimi 自带的运行时不是 Node，不能替代。dws 安装脚本只装 dws，dtmcp 要单独 `npm i -g`
1. 装 `dws`
   - macOS / Linux：`curl -fsSL https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.sh | sh`
   - Windows（PowerShell）：`irm https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.ps1 | iex`
     - 安装脚本靠跟踪 GitHub `releases/latest` 重定向推断版本；跟踪失败时报 `Could not determine the latest version`。设 `$env:DWS_VERSION = "v1.0.65"` 可跳过版本检测直接下载
     - release 下载本身超时可用 Gitee 镜像：`$env:DWS_GITEE_REPO = "DingTalk-Real-AI/dingtalk-workspace-cli"` + `$env:DWS_VERSION = "v1.0.63"`（镜像落后 GitHub 几个补丁版）
     - 不需要安装钉钉桌面客户端：`dws auth login` 走浏览器，无浏览器用 `--device`
2. `dws auth login`（无浏览器环境用 `--device`）；若提示组织未开 CLI 访问，按引导提交申请给管理员
3. `dws profile list` 记下要用的 profile（多账号组织必须显式指定，`dtmcp` 存的是 profile 而非姓名）
4. `dtmcp --version` 看版本、`dtmcp doctor` 确认就绪（dws 安装与登录态都在这一关检查）
5. `dtmcp daemon` 起守护进程（MCP 经 IPC 连它；需常驻；push 默认开启，`dtmcp off` 可关）
6. 在 agent 的 MCP 配置里加：
```json
{ "mcpServers": { "dingtalk-mcp": { "command": "dtmcp", "args": ["mcp"] } } }
```
（要求已全局安装；当前未发布 npm，`npx -y dtmcp` 不可用）
7. 首次 `ask_on_dingtalk` 或 `dtmcp run` 会自动创建项目群（v2.2），无需 `dtmcp init`；端到端测试=问一个问题并在手机作答

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-18 | 初版：选型、架构、接口、状态机 |
| v1.1 | 2026-10-18 | 增 macOS/Windows/Linux 三端与 npm 分发：新增 `platform/` 层与「不得读 `process.platform`」边界规则；IPC 由「Unix socket」改为「POSIX socket / Windows 命名管道」双实现；单实例判定从 PID+flock 改为 bind 探测；新增 FR10 `doctor`、FR11 多使用者隔离、§8.2 聊天留存知情说明、§13 仓库与分发形态、V4/V5 验证项。V1 实测通过（本人单聊可用），V2/V3/V4/V5 待验 |
| v1.2–v1.6 | 2026-10-18/19 | 多项目支持演进：v1.3 引入 Session 隔离；v1.4 改为每项目独立钉钉群（`{project_title}问答`），路由按会话 ID 定位项目、免 `#Q1:` 前缀；v1.5 实测确认 `dws event consume` 实时接收可用；v1.6 支持手机主动发消息、项目收件箱、自动确认与回显过滤（8 个 MCP 工具） |
| v1.7 | 2026-10-19 | 摄入架构替换：dws 事件总线发生假死事故（自报 connected 但 received 恒 0，重启无效），整条改为 `ChatPoller` 3 秒轮询 + messageId 幂等 + 重启基线化（§3.5.6）。新增无头 Agent 处理链路 `AgentRunner`（§3.5.10）：手机主动消息由 `qodercli -p --strict-mcp-config` 按 CLI 同等语义处理，只回推最终结果；15s 延迟 ack、15min 超时、结果截断；权限模式可配置（默认 full，`read-only`/`accept-edits` 可选）。workdir 绑定：ask RPC 附带 `cwd`，随 `project-chats.json` 持久化 |
| v1.8 | 2026-10-19 | 架构评审 + 实测驱动转向：无头运行零记忆（手机发 "continue" 得到"没有可续的任务"），根因是上下文挂在会话而非项目。实测验证 qodercli hooks（与 Claude Code 同构）的 `additionalContext` 能进入模型上下文、`Stop` 事件带 `last_assistant_message`，`remote-control`/`--teleport` 为云中介无本地注入路径（否决）。会话树状 JSONL 并发写入会孤儿化分支（否决 "-r 写入 PC 活动文件" 方案） |
| v1.9 | 2026-10-20 | 手机 ↔ 电脑活会话双通道（Hook 架构，§3.5.10 重写）：手机钉钉作为同一 Agent 会话的第二 I/O 通道。`dtmcp install-hooks` 外科手术合并 `~/.qoder/settings.json` hooks（幂等、备份、保留用户配置）；`dtmcp hook` 子命令经 IPC 分发——`SessionStart/PostToolUse/UserPromptSubmit` 认领未读手机消息并注入 `additionalContext`，`Stop` 镜像最终回复回手机，`SessionEnd` 注销。`session-registry.ts` 活会话登记（2h 过期自愈）；`claimUnread` 先到先得。inbox 到达改三分支路由：有活会话→提示下一步处理；无会话且 `agent.headless=true`→无头代班；默认关→"qodercli 在电脑上未启动"。无头 runner spawn 注入 `DTMCP_HEADLESS=1` 使 hooks no-op（递归保护）。`agent.headless` 解析：env > config.json > false |
| v2.0 | 2026-10-20 | 需求升级："项目 CLI 开着即可接收并执行手机指令（无论空闲）"。新增 `dtmcp run` PTY 包装器（§3.5.10.2）：node-pty 内启动 qodercli，透明代理按键；`InjectionLoop` 每 2s `hook_ping`+`hook_poll` 认领未读消息，以括号粘贴 + **分离的 300ms 延迟回车**写入 TUI（同块回车不提交——实测踩坑），空闲即时执行完整 CoT，回复经 Stop hook 镜像回群，回到电脑同会话无缝接续。`core/injector.ts` 编码内核（>5 行或 >500 字符改字面输入防 `[Pasted Text]` 折叠、控制字符 sanitize、CRLF 归一）。热车保护：首次渲染 + 3s 稳定窗后才开始认领；RPC 全容错护住用户终端。`DTMCP_WRAPPED=1` 使被包装会话边界 hook 免认领防双重消费。单实例锁带 PID 文件与死进程回收。node-pty macOS `spawn-helper` 丢可执行位 → `postinstall chmod +x` 修复 |
| v2.1 | 2026-10-20 | 双评审（架构师+资深开发）修复批次，全量 TDD：**P0** socket 响应封装改 `{...result, id: request.id}`，业务 id 更名 `questionId`（此前 `ask` 等业务返回的顶层 `id` 覆盖 JSON-RPC 关联 id → 客户端永久挂死）；`security.allowedSenderIds` 发送者白名单（未配置=放行+启动告警，命中外发送者整条忽略不回执）。**P1** `hook_poll` 两阶段投递：认领=60s 租约，注入成功 `hook_ack` 落读、pty 写异常 `hook_unclaim` 立即归还、崩溃靠过期自动重投（至少一次语义，`claimUnread` 不再认领即置读）；InjectionLoop tick 重入保护 + stop 后丢弃已认领消息；`dtmcp run` 注册 SIGTERM/SIGHUP（还原 raw mode、击杀子进程防孤儿），loop 写改为透传异常以驱动 unclaim，stdin 代理维持 EIO 容错；回声过滤去空白规范化 + ≥20 字包含判定（钉钉重排/截断回声不再当用户消息）；`project-chats.json`/`state.json` 原子写（tmp+rename）且解析失败**保全**原件为 `*.corrupt-<ts>` 并告警（不再静默清空）；daemon `stop()` 主动销毁在册 IPC 连接（长连接曾使 `server.close()` 永不回调、SIGTERM 挂死需 kill -9）。测试 233 全绿 |
| v2.2 | 2026-10-21 | 修复"`dtmcp run` 启动的新项目在钉钉没有对应群、手机无法主动发消息"：包装器 `start()` 在 `hook_ping` 后调用新增 RPC `hook_register {cwd}`；daemon 按 `getProjectByWorkdir` 命中则复用，未命中则以 cwd 目录名作为 projectId/projectTitle（群名"<目录名>问答"）调 `getOrCreateChat` 建群、`setWorkdir` 绑定并触发 `onChatCreated` 开始轮询。注册失败不影响注入循环（safeRequest 容错），群已存在时幂等。限制：不同路径同名目录会共用/覆盖同一 projectId 的 workdir 绑定 |
| v2.3 | 2026-10-21 | v0.1.0 分发修复 + Windows 安装排错：**分发**：npm 11.12.1 对 git 依赖在克隆目录内跑生命周期脚本、且此时依赖未装齐，`prepare`/`postinstall` 里构建必然 `tsc: command not found` → 改为 **`dist/` 提交入库**（移出 .gitignore），`postinstall` 只留 node-pty `chmod +x`，typescript/@types 回归 devDependencies；实测 `npm i -g --install-links github:...#v0.1.0` 与 GitHub archive tarball 两路均可装出可用 `dtmcp`（npm 11 不加 `--install-links` 时 git 依赖会链到已删除的临时克隆 → 半空安装，README 已写明）。**Windows**：dws `install.ps1` 跟踪 `releases/latest` 重定向失败报 `Could not determine the latest version` → `$env:DWS_VERSION="v1.0.65"` 跳过检测；下载超时走 Gitee 镜像（落后到 v1.0.63）；确认**无需钉钉桌面客户端**，`dws auth login` 浏览器/`--device` 即可。另：Windows 必须先装 Node LTS——dws 安装脚本只装 dws，qodercli/Kimi 自带运行时不含可用的 Node/npm，`dtmcp` 需单独 `npm i -g` |
| v2.4 | 2026-10-22 | Windows `dtmcp run` 无法启动 agent CLI（`Error: Cannot create process, error code: 2`）：node-pty 把命令行直接交给 `CreateProcessW`，只补 `.exe`，npm 全局 bin 的 `.cmd` 包装（qodercli/Kimi/claude 全部如此）永远解析不到；且其 `get_shell_path` 探测不追加 `.exe`，连裸名 `cmd` 都判定不存在（`Error: File not found: `）。新增 `resolveWindowsLaunch`（src/cli/run.ts）：win32 下按 cwd→PATH 解析 `.exe/.com/.cmd/.bat`（优先 `.exe`，跳过 npm 同时安装的无扩展名 sh 脚本），`.exe` 以绝对路径直启，`.cmd/.bat` 经 `%ComSpec%` 包装；包装命令行必须以**字符串**形式传给 node-pty（数组形式会按 MSVC argv 规则把引号转义成 `\"`，cmd.exe 无法解析），`/s` 下 cmd 剥掉首尾一对引号，批处理路径恒加引号以容纳空格。找不到目标时抛出明确错误。Windows 11 + Node 24 实测：`dtmcp run qodercli --version`、`dtmcp run npm --version`（含空格路径的 .cmd）、`dtmcp run node --version` 均通；daemon 的 Unix socket 测试套件在 Windows 仍报 EACCES（既有问题，命名管道全流程未测） |
| v2.5 | 2026-10-24 | v0.1.1：`resolveWindowsLaunch` 改用具名 `path.win32`（此前用宿主 `node:path`，在 macOS 上 `delimiter`/`join`/`resolve` 全按 POSIX 处理，Windows 路径解析与 8 个单测必挂；该函数仅 win32 分支调用，与宿主平台无关）。打包发布 v0.1.1，README 安装命令指向新 tag、Windows 兼容性表补充命名管道 daemon 实测结论，并新增 Upgrade 小节（原地重装 + 重启 daemon，说明 pending 状态保留与 `dtmcp --version` 不存在） |
| v2.6 | 2026-10-24 | v0.1.2：新增版本查询 `dtmcp version` / `--version` / `-v`（运行时读取安装包自带的 package.json，源码检出与全局安装布局均可解析；此前只能用 `npm ls -g dtmcp` 间接确认）。README CLI 命令表、Upgrade 校验步骤与安装命令同步指向 v0.1.2 |
| v2.7 | 2026-10-24 | 安装/升级文档巡检：安装、跟踪 main、升级三类命令按 OS 拆成独立代码块（Windows 用 archive tarball，macOS/Linux 用 git 依赖），避免一次复制到两条命令；修正 How It Works 中不存在的 `dtmcp reply`、贡献链接占位符与平台状态描述；补充无浏览器 `dws auth login --device`、push 默认开启、`dtmcp --version` 校验，以及"问题以本人账号发出、手机可能无推送提醒需手动打开项目群"的提示。§13 安装行标注 npm/npx 尚未可用，§4.3 实现状态更新到 v2.6 并注明 `doctor --format json` 未实现 |
| v2.8 | 2026-10-24 | v0.1.3：`dtmcp doctor` 标题行显示当前版本（`dtmcp doctor (0.1.3)`），排错时无需再 `npm ls -g` 反查；README 安装/升级命令与 tag 指向 v0.1.3 |
