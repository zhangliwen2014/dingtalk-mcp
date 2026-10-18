# 设计文档：dingtalk-mcp（钉钉远程问答桥）

版本：v1.1（待评审）
日期：2026-10-18
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

方法集合与 MCP 工具一一对应（`ask` / `check` / `cancel` / `status` / `reply` / `set_switch`），外加两个内部方法：`hello`（版本握手，客户端据此判断能否 `{"method":"spawn"}` 自行拉起 daemon）、`ingest`（transport 把入站消息喂进 core）。

多出的两个方法说明 **MCP 工具集合 ≠ daemon RPC 集合**：`reply` 给 CLI 用，`set_switch` 给 CLI 和手机端指令共用，`hello`/`spawn`/`ingest` 是纯内部。这是有意的分层——MCP 面只暴露 agent 需要的四个动作，其余留在本机。

### 4.3 CLI 命令

```
dtmcp doctor                     # 前置条件全量自检（FR10），未通过项给下一步动作
dtmcp init [--target <名称>]     # 解析并持久化本人专属目标会话（D5/FR11 的落地处）
dtmcp on | off | status          # 开关
dtmcp ask "问题" [选项...]        # 手动发一条（调试）；长文本用 --file 或 stdin
dtmcp reply <id> <文本>           # 电脑端作答（G3）
dtmcp pending                    # 列待答
dtmcp start | stop | logs        # daemon 生命周期
dtmcp smoke                      # 真机冒烟：登录 → 目标 → 发一条 → 等回复
```

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
| V2 | `dws event +listen-im --kind all-direct` 是否实时收到发给本人的单聊消息；入站结构里发送者、正文、会话 ID 的真实字段名 | `DwsTransport.listen` 的实现；§6.1 推送式接收 | **待验证** | 退化为 `+chat-messages --start` 轮询，重估 NFR9 延迟预算 |
| V3 | 同一账号两个 `dws event consume` 订阅同一 EventKey 是 fan-out 还是互抢 | NFR5 单实例是建议还是硬约束 | **待验证** | 单 daemon 架构无论如何保留（跨客户端开关状态同样必需） |
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
| 安装 | `npm i -g dtmcp` 或零安装 `npx -y dtmcp mcp` 直接写进 agent 配置（NFR16） |
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

1. 装 `dws`
   - macOS / Linux：`curl -fsSL https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.sh | sh`
   - Windows（PowerShell）：`irm https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.ps1 | iex`
2. `dws auth login`（无浏览器环境用 `--device`）；若提示组织未开 CLI 访问，按引导提交申请给管理员
3. `dws profile list` 记下要用的 profile（多账号组织必须显式指定，`dtmcp` 存的是 profile 而非姓名）
4. `dtmcp init` 解析本人专属目标会话
5. `dtmcp doctor` 确认就绪
6. `dtmcp smoke` 确认端到端通（手机上要答一次）
7. 在 agent 的 MCP 配置里加：
```json
{ "mcpServers": { "dingtalk-mcp": { "command": "npx", "args": ["-y", "dtmcp", "mcp"] } } }
```
（全局安装后可写成 `{ "command": "dtmcp", "args": ["mcp"] }`）

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-18 | 初版：选型、架构、接口、状态机 |
| v1.1 | 2026-10-18 | 增 macOS/Windows/Linux 三端与 npm 分发：新增 `platform/` 层与「不得读 `process.platform`」边界规则；IPC 由「Unix socket」改为「POSIX socket / Windows 命名管道」双实现；单实例判定从 PID+flock 改为 bind 探测；新增 FR10 `doctor`、FR11 多使用者隔离、§8.2 聊天留存知情说明、§13 仓库与分发形态、V4/V5 验证项。V1 实测通过（本人单聊可用），V2/V3/V4/V5 待验 |
