# 设计文档：dingtalk-mcp（钉钉远程问答桥）

版本：v1.0（待评审）
日期：2026-10-18
关联文档：[需求文档](./requirements.md)

---

## 1. 系统上下文

本项目不直接对接钉钉开放平台协议，而是把钉钉的收发能力外包给官方开源的 `dws` CLI，自己只实现「问答编排」这一层语义：待答状态、开关、回复归属、两端先到先得、超时与回查。

```
┌────────────┐  stdio MCP   ┌──────────────┐  Unix socket  ┌──────────────┐
│ Qoder CLI  │─────────────▶│ dtmcp mcp    │──────────────▶│              │
│ Kimi CLI   │─────────────▶│ (薄客户端 ×N) │               │   dtmcpd     │
│ 其他 agent │─────────────▶│              │               │  (唯一 daemon)│
└────────────┘              └──────────────┘               │              │
                                                            └──────┬───────┘
                                                    exec / spawn   │
                                                            ┌──────▼───────┐
                                                            │     dws      │
                                                            │ (官方开源CLI) │
                                                            └──────┬───────┘
                                                                   │ 个人 OAuth 长连接
                                                            ┌──────▼───────┐
                                                            │   钉钉服务端   │
                                                            └──────────────┘
```

**为什么薄客户端要拆出来**：MCP 客户端对 stdio server 是「每个客户端各起一个进程」。如果问答逻辑住在这个进程里，Qoder 和 Kimi 就会各自持有一个钉钉消息订阅，两个订阅者抢同一份入站消息，回复有概率落到没有那个待答问题的进程里，表现为「明明回答了 agent 却没反应」。把状态集中到唯一 daemon 是这个问题的直接解法，也顺带满足了 NFR5（单实例）和 NFR4（重启恢复）。

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
| client ↔ daemon 通道 | Unix domain socket（`~/.../dtmcp.sock`） | 免端口冲突、免 HTTP 栈、天然本机限定、文件权限即访问控制（NFR8）。代价：不支持远程 daemon——阶段 4 若要把 daemon 搬到服务器，届时换一层可插拔 transport |
| daemon 由谁拉起 | 薄客户端首次调用时探测 socket，不通则 detached spawn，最多等 2 秒 | 用户零操作。代价：首次提问有冷启动延迟，计入 NFR9 的 15 秒预算 |
| 入站消息获取 | `dws event +listen-im` 常驻子进程，读 ndjson 流 | 推送式，无需轮询，满足 NFR9。若 D5 使单聊不可用，改为 `--kind group --chat-id` |
| 出站消息 | exec `dws chat +dm`（或 `+send-to-group`） | 每次调用一个进程，无长连接负担。关闭态提问不触发任何进程（NFR10） |
| 待答状态存储 | 单个 JSON 文件，daemon 内存为准，写时同步落盘 | 简单、可读、可人工修（NFR4）。放弃 SQLite：数据量是个位数到几十条，不值得多一层依赖 |
| 问题编号 | 全局单调递增整数 `Q1, Q2...`，落盘持久 | 手机端唯一可靠的上下文线索（FR4）。不用 UUID——人在手机上抄不进 UUID |
| 按钮式回复 | 阶段 1 不做 | 受 D7 限制。文本 + 编号已满足 FR1/FR4，且少一项用户配置 |
| 长轮询默认时长 | 45 秒 | 必须显著小于客户端工具超时。保守取 45s 而非 120s：宁可让模型多查一次，也不要被客户端切断后行为不可知 |
| 并发待答 | 不排队 | 见需求 FR4；靠归属规则兜住歧义 |

## 3. 模块划分

```
src/
  core/                 ← 纯业务，不依赖 dws、不依赖任何 agent 客户端
    question.ts         ← 问题实体与状态机
    registry.ts         ← 待答问题表、编号分配、持久化
    router.ts           ← 入站消息 → 归属判定（FR4 四条规则）
    switch.ts           ← 全局开关读写
    errors.ts           ← blocked 原因枚举
  transport/
    ding-transport.ts   ← 接口：sendText / listen / resolveTarget
    dws-transport.ts    ← 实现：exec + spawn dws
    fake-transport.ts   ← 测试实现
  daemon/
    server.ts           ← socket RPC 服务，装配 core + transport
    single-instance.ts  ← 单实例锁与版本握手
  mcp/
    server.ts           ← 薄客户端：连 daemon，暴露 4 个 MCP 工具
  cli/
    index.ts            ← dtmcp on|off|status|reply|ask|init|start|stop|smoke
  adapters/             ← 阶段 2/3：客户端相关适配层，与 core 隔离
    (qoder-hooks.ts)    ← 预留，阶段 1 不创建
```

**边界规则**（这是阶段 2/3 不污染阶段 1 的机制保障）：
- `core` 不允许 import `transport`，只依赖 `DingTransport` 接口。
- `mcp` 不允许 import `core`，只能通过 socket 调 daemon。这强制了「多客户端共享一份状态」而不是各存各的。
- `adapters/` 是唯一允许出现某个 agent 专有概念（hook 事件名、权限回调签名）的目录。阶段 2 加进去时，`core` 和 `mcp` 不改动。

每个模块的职责、使用方式与依赖：

| 模块 | 做什么 | 怎么用它 | 依赖什么 |
|---|---|---|---|
| `core/question.ts` | 定义问题及其合法状态转换；非法转换（如已答后再答）在这里拒绝 | 构造 `Question.create({text, options, projectId, timeoutMs})`，调 `q.accept(text, source)` 返回 `AcceptResult` | 无 |
| `core/registry.ts` | 编号分配、待答索引、过期清理、落盘 | `registry.open(q)` / `registry.get(id)` / `registry.listPending()` / `registry.load()` | `question.ts` |
| `core/router.ts` | 把一条入站文本判成一个动作 | `route(text, pendingList)` → `{kind:'answer',id,text}` / `{kind:'command',cmd}` / `{kind:'ambiguous'}` | `question.ts` |
| `transport/dws-transport.ts` | 唯一与 dws 和钉钉协议打交道处 | `sendText(target,text)` / `listen(handler)` / `resolveTarget(name)` | `dws` 可执行文件 |
| `daemon/server.ts` | 装配，持有全部状态，回答 RPC | 由 `dtmcp start` 或客户端自动拉起 | core + transport |
| `mcp/server.ts` | MCP 协议 → daemon RPC 的翻译 | 写进 agent 的 mcp 配置 | daemon socket |

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
  "dws": { "available": true, "version": "...", "logged_in": true, "profile": "corpId:userId" },
  "target": { "resolved": true, "type": "self_dm|group", "display": "..." },
  "listener": { "connected": true, "restarts": 0, "last_error": null },
  "pending": [{ "id": 3, "project": "dingtalk-mcp", "asked_seconds_ago": 41 }]
}
```
这个工具是 FR7 的实现。它必须能区分「开关关着」「没登录」「监听断了」「已推送但没人回」，因此四个字段各自独立，不合并成一个健康布尔值。

### 4.2 daemon socket RPC

换行分隔 JSON（NDJSON），一行一请求一行一响应。不用 HTTP：没有多资源、不需要 REST 语义，socket + NDJSON 少了整套 HTTP 依赖。

请求：`{"id":1,"method":"ask","params":{...}}`
响应：`{"id":1,"result":{...}}` 或 `{"id":1,"error":{"code":"...","message":"..."}}`

方法集合与 MCP 工具一一对应（`ask` / `check` / `cancel` / `status` / `reply` / `set_switch`），外加两个内部方法：`hello`（版本握手，客户端据此判断能否 `{"method":"spawn"}` 自行拉起 daemon）、`ingest`（transport 把入站消息喂进 core）。

多出的两个方法说明 **MCP 工具集合 ≠ daemon RPC 集合**：`reply` 给 CLI 用，`set_switch` 给 CLI 和手机端指令共用，`hello`/`spawn`/`ingest` 是纯内部。这是有意的分层——MCP 面只暴露 agent 需要的四个动作，其余留在本机。

### 4.3 CLI 命令

```
dtmcp init [--group <群名>]      # 解析并持久化目标会话（D5 的落地处）
dtmcp on | off | status          # 开关
dtmcp ask "问题" [选项...]        # 手动发一条（调试 / 从终端主动问）
dtmcp reply <id> <文本>           # 电脑端作答（G3）
dtmcp pending                    # 列待答
dtmcp start | stop | logs        # daemon 生命周期
dtmcp smoke                      # 真机冒烟：登录 → 目标 → 发一条 → 等回复
```

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

`~/.dingtalk-mcp/`（权限 0700）：

```
state.json          # 0600，见下
daemon.pid          # 0600
daemon.sock         # Unix socket，0600
daemon.log          # 0600，轮转上限 5MB
```

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
| 多个 daemon 竞争 | `daemon.pid` + `flock`；拿到锁才继续。拿不到则探测 socket 并做 `hello` 版本握手：版本匹配就复用现有 daemon，不匹配则报错要求重启（旧 daemon 与新客户端协议不一致必须显式失败，不能静默兼容） |
| 客户端首次调用而 daemon 未起 | `mcp/server.ts` 尝试连 socket，失败 → detached spawn + 最多 2 秒等待 → 仍失败返回 `blocked(daemon_unavailable)` |
| dws 升级改命令/字段 | 所有 dws 调用集中在 `dws-transport.ts` 一个文件。dws 的 skill 文档明确要求「按真实返回判断，不猜字段」，本实现遵循：解析失败记 `transport_schema_drift`，不降级为「当成没收到」 |
| 人在提问后回到电脑想本地答 | 已覆盖（6.2）。`dtmcp pending` 列出待答，无需记编号 |

## 8. 安全与隐私

推送到手机的消息会经过钉钉服务端并持久化在聊天记录里，因此默认最小化外传内容：

- 消息正文只含：`【dingtalk-mcp · <项目名> · Q<id>】` + 问题文本 + 编号候选项。
- **`context` 参数默认不发送**，即使 agent 填了。要发必须显式 `context_opt_in`，且在 daemon 日志里留下这条决定（可审计）。这条限制来自 NFR7，理由：模型很容易把整段报错栈、文件路径、甚至配置片段塞进问题正文，其中可能含内部主机名或密钥。
- 输入校验：问题文本 > 500 字符时**截断并标注**，同时在 MCP 结果里提示 agent「正文过长，已截断，请精简或改本地提问」。不是拒绝，也不是全量发。
- 不记录：ClientID/Secret、OAuth token、refresh token、`dws` 输出里的任何凭证字段。日志只记命令名与退出码，不记 `dws` 的原始 stdout（其消息正文可能含用户输入内容，且我们不需要）。
- 文件权限：目录 0700，文件与 socket 0600（NFR8）。
- `state.json` 里的问题文本会落盘。这是必要的（重启恢复），但要写进 README：机器上其他用户读不到，备份/同步这个目录等于同步聊天记录。

## 9. 测试策略

| 层 | 覆盖 | 方式 |
|---|---|---|
| 单元（`core/router`） | FR4 四条规则全分支：指令优先于答案、带编号定向、唯一 pending 自动归属、多 pending 无编号 → ambiguous、`#忽略` | 纯函数测试，无需 mock |
| 单元（`core/question`） | 状态机不变式：pending 只能由发送成功进入；二次回答被拒且返回既有答案；终态不可变 | 表驱动测试 |
| 单元（`core/switch`） | 关闭态短路、持久化后重启保持、`#关`/`#开` 生效 | 临时目录 |
| 集成（daemon + `FakeTransport`） | 6.1 全链路（假传输注入入站消息）、6.2 先到先得两方向、6.4 超时返回 pending 后答案仍可回查、监听重启后 pending 存活 | 起真实 socket server 在临时 socket |
| 契约测试（`DwsTransport`） | 对 dws 输出结构的解析：给固定 fixture（真实 dws 输出的脱敏样本），断言解析；字段缺失时报 drift 而非静默 | fixture |
| 真机冒烟 | `dtmcp smoke`：登录态 → 目标可解析 → 手机收到 → 人回复 → 结果返回；每一步打印明确成功/阻塞 | 人工执行，阶段 1 退出前必须跑通 |
| 端到端（客户端） | 在 Qoder 里配好 MCP，让 agent 真的提一次问；在 Kimi 里重复（FR8） | 人工 |

`FakeTransport` 是这套测试成立的前提：它让「人何时回复」在测试里可控，包括「先答两次」「答得极慢」「dws 发送失败」这些真实场景下很难复现的分支。

## 10. 分阶段实现路线

### 阶段 1（本期，即需求 FR1–FR9）
1. 前置验证（§12 的三条命令）→ 确定 `target.type` 是 self_dm 还是 group
2. `core` 四个模块 + 单测（先写测试再写实现，router 与状态机是重点）
3. `DingTransport` 接口与 `FakeTransport`
4. `daemon` + socket RPC + 单实例锁
5. `mcp/server.ts` 四个工具
6. `cli`：`init/on/off/status/reply/pending/smoke`
7. 集成测试 + 真机冒烟 + Qoder 端到端

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

## 12. 开放问题与前置验证

必须在写第一行实现代码之前用真实 dws 验证。这三条命令由用户在本机执行（需要浏览器交互登录）。

| # | 待验证 | 影响的决策 | 若失败 |
|---|---|---|---|
| V1 | `dws chat +dm --to <本人姓名>` 能否把消息发给自己 | `target.type`；FR1 消息形态 | 改为建/复用一个专用小群，监听 `--kind group --chat-id`，CLI 增 `dtmcp init --group` |
| V2 | `dws event +listen-im --kind all-direct` 是否实时收到发给本人的单聊消息；入站结构里发送者、正文、会话 ID 的字段名 | `DwsTransport.listen` 的解析实现；§6.1 的推送式接收 | 退化为 `+chat-messages --start` 轮询，重估 NFR9 延迟预算 |
| V3 | 同一账号起两个 `dws event consume` 订阅同一 EventKey，事件是 fan-out 还是互相抢 | daemon 单实例是否强制（NFR5 是建议还是硬约束） | 无论结果如何，单 daemon 架构保留（跨客户端开关状态同样必需）；只是 §7 的竞争处理严格程度不同 |

另外三项待核对，不阻塞阶段 1：

- `dws event` 的订阅是否需要显式 stop 清理（`dtmcp stop` 时若遗留订阅，下次 `dws event status` 会看到僵尸订阅）
- `dws` 的「CLI 访问管理」在个人测试组织下的开通路径
- 长轮询 45 秒与各家 MCP 客户端工具超时默认值的具体关系，需要在 Qoder 和 Kimi 各测一次实际切断时间

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

## 附录 B：用户侧一次性准备

1. 安装 dws（curl 脚本 / npm / brew，见附录 A 仓库 README）
2. `dws auth login` —— 若组织未开 CLI 访问，会引导提交申请；本人是管理员，审批卡片一键通过
3. `dws profile list` 记下要用的 profile（多账号组织必须显式指定）
4. `dtmcp init` 解析目标会话（或 `--group`）
5. `dtmcp smoke` 确认端到端通
6. 在 agent 的 MCP 配置里加：
```json
{ "mcpServers": { "dingtalk-mcp": { "command": "dtmcp", "args": ["mcp"] } } }
```
