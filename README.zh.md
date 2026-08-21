# dsh-experimental-agent-codex

[English](README.md) | 中文

一个实验性的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，通过公开 app-server 协议，使用用户自己的 [OpenAI Codex CLI](https://github.com/openai/codex) 替换默认 Agent Loop。

本仓库只负责桥接。它绝不安装或升级 Codex，不发起登录或退出，不读取 Codex 认证文件，不写入 Codex 配置，也不捆绑 `@openai/codex`。Codex 可执行文件、版本、`CODEX_HOME`、账户、MCP 配置和内置工具均由用户管理。

## 当前状态

这是实验性首版。它保留 Harness Agent、Session、inbox、UI／ACP、流式文本、usage、steering、取消、恢复和 teardown 接口。它尚未把 Harness 工具或 Harness approval UI 桥接到 Codex。重要工作区使用前请阅读下文的兼容性限制。

## 前置条件

- DeepSeek Harness `0.1.0-rc.8` 或兼容的后续 `0.1.x` 版本。
- 该 Harness 版本支持的 Node.js 和 pnpm。
- 用户自行管理、且 `app-server` 支持 stdio JSON-RPC 的 Codex CLI。

使用 OpenAI 支持的方式安装 Codex，然后自行完成认证：

```sh
codex --version
codex login
```

插件加载时不会检查 Codex 是否安装或登录。第一次创建 Agent 时才会报告用户 Codex 安装产生的可执行文件、协议、认证或账户错误。

## 安装

将 bundle 安装到每个需要使用 Codex 的 Harness profile。它会替换 profile 中既有的 `agent-loop` 行；不要再用另一个行 id 挂载 `@deepseek-ai/dsh-agent-loop`。

```sh
# Browser profile
dsh plugin --profile web add github:CaineWind/dsh-experimental-agent-codex

# Headless profile
dsh plugin --profile headless add github:CaineWind/dsh-experimental-agent-codex
```

固定经过审查的 commit 可让安装结果复现：

```sh
dsh plugin --profile web add github:CaineWind/dsh-experimental-agent-codex#<commit-sha>
```

仓库提交预构建的 `lib/` 文件，因此从 GitHub 安装不需要允许 dependency build script。

重启 profile，然后检查有效配置：

```sh
dsh --profile web --dump-config
```

有效配置应禁用 base 行并加入桥接器：

```yaml
- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  disabled: true
- id: agent-codex
  name: dsh-experimental-agent-codex
  config:
    command: codex
    args: [app-server, --listen, 'stdio://']
    approvalPolicy: never
    sandbox: workspace-write
    disposeGraceMs: 3000
```

## 使用

重启后，像平常一样使用该 profile：

```sh
# Browser application
dsh --profile web

# One headless task
dsh --profile headless "Inspect this repository and summarize its architecture"
```

创建 Harness Session 会启动一个 Codex app-server 进程并创建一个持久 Codex thread。关闭 Session 会停止进程树。恢复 Harness Session 会启动新的 app-server 进程，并使用已记录的 thread id 调用 `thread/resume`。

Codex thread 数据仍位于用户的 Codex home。如果用户删除或更改了对应 Codex 状态，已持久化的 Harness Session 将无法恢复该 thread。

## 配置

在 profile 自己的 `cordis.patch.yml` 中覆盖 bundle 默认值：

```yaml
- id: agent-codex
  config:
    command: codex
    args: [app-server, --listen, 'stdio://']
    approvalPolicy: never
    sandbox: workspace-write
    disposeGraceMs: 3000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `command` | `codex` | 用户管理的可执行文件 PATH 名称或绝对路径。 |
| `args` | `[app-server, --listen, 'stdio://']` | 完整 app-server 参数。 |
| `env` | `{}` | 在 Harness subprocess 环境清洗后显式叠加的环境变量。 |
| `cwd` | 无 | Harness Session 没有工作目录时使用的 fallback。 |
| `approvalPolicy` | `never` | `untrusted`、`on-failure`、`on-request` 或 `never`。 |
| `sandbox` | `workspace-write` | `read-only`、`workspace-write` 或 `danger-full-access`。 |
| `disposeGraceMs` | `3000` | 进程树 termination 升级前的宽限时间。 |

部分旧版 Codex 使用不同的 app-server 参数。检查 `codex app-server --help` 后，只覆盖 `args`，仍由用户管理 Codex：

```yaml
- id: agent-codex
  config:
    args: [app-server, --stdio]
```

### 认证和环境变量

子进程继承普通环境值，包括 `PATH`、`HOME`、代理和 `CODEX_HOME`，因此正常 Codex 登录状态仍由用户管理。

Harness 会有意移除 `OPENAI_API_KEY` 等凭据形式的环境变量。通过环境 key 认证 Codex 的部署必须显式选择传入：

```yaml
- id: agent-codex
  config:
    env:
      OPENAI_API_KEY: !!js process.env.OPENAI_API_KEY
```

绝不要在提交的 patch 中写入明文凭据。

## 运行时行为

每个活跃 Harness Agent 拥有一个 app-server 进程和一个持久 Codex thread。新 Session 会在 `codex/thread-linked` 中记录 thread id 和已观察 app-server 版本。没有 `turn/start` 的持久化空白 Session 可在更换 AgentFactory 后被接管：桥接器会先创建并记录其第一个 Codex thread，再接受第一条 prompt。Codex 负责其内部对话；Harness 保留 UI、ACP、inbox、生命周期和审计投影。

`command` 解析为 Windows `.cmd` 或 `.bat` shim 时，桥接器通过原生 `cmd.exe` 启动它，并将解释器及其后代作为一棵受管进程树。

一个 Harness turn 对应一个 Codex turn。最终回答 delta 会变成 `assistant/chunk`，组装回答会变成 `assistant/message`，报告的 usage 会变成标准的互斥 `TokenUsage`。缓存输入以 `cacheReadTokens` 记录，并从未缓存的 `inputTokens` 中扣除。

创建 thread 时，组装后的 Harness system prompt 会作为 Codex developer instructions 传入，并记录到 `request/header`。桥接器会提供属于所选 AgentFactory 的标准 `provider`、`model` 和 `cwd` prompt 变量。恢复时使用 thread 已有的 instructions。

command、文件修改、permission、用户输入和 MCP elicitation 等交互请求会收到安全的无人值守拒绝响应。默认 `approvalPolicy: never` 避免交互式 approval 往返。因此，在 `workspace-write` 下，请求额外权限的浏览器或 computer-use 工具会被拒绝；受信任的 profile 可以设置 `sandbox: danger-full-access`，这会移除该 thread 的 Codex sandbox。

## 模型体验

### Codex thread 请求

#### 模型可见内容

Codex 通过 `thread/start.developerInstructions` 接收组装后的 Harness system prompt。之后每个 `turn/start.input` 会收到准入的用户文本；Harness 工具定义和后续 prompt 变更不会发送给 Codex。

#### Token 影响

Developer instructions、Codex 管理的 thread 历史和用户文本会占用 Codex context window。桥接器不会增加固定的模型可见文本，并将 app-server usage 投影到 Harness Session。

#### KV Cache 影响

Codex 负责其 thread 的 cache 行为。恢复时复用 Codex thread identity，新 Session 则创建独立的 thread 状态；更改用户管理的 Codex model 或已存储 thread 状态可能改变 cache 复用。

## 已知限制与暂缓事项

- Codex 使用自己的内置工具和已配置 MCP 工具。Harness `ctx.tools` 不会导出，Codex 内部调用也不会投影为 Harness `tool/call` 和 `tool/result` 事件。
- 公开 app-server 协议不会暴露每次内部模型请求。桥接器无法复刻 `agent/request`、`agent/pre-step`、Harness LLM adapter、retry、请求重建或精确的请求级 KV-cache 行为。
- 输入仅支持文本。图像和插件定义的内容块会在跨进程前失败。
- 尚未桥接 Harness approval UI。交互式 Codex 请求会被拒绝，而不会保持 pending。
- 创建 thread 时会发送 `AgentOptions.model`。`provider` 用于标记 Harness 投影。`maxTokens` 没有 app-server 对应字段，因此不会应用。
- thread 创建后的 system-prompt 变更以及 Harness 动态 tool／context assembly 不会同步到已有 thread。
- 只有安装此 bundle 的 profile 才会替换 AgentFactory；全局默认值不变。
- 在其他 `AgentFactory` 下已开始对话的 Session 没有 Codex thread，因此不能通过本桥接器继续。空白 Session 没有需要跨 runtime 继承的 turn 历史，可以被安全接管。

## 故障排查

### 启动时报错 `cannot get property "agents" without inject`

此错误表示已安装包的 Cordis 注入元数据在 Loader 归一化时丢失。更新 Git 依赖，然后重启 profile：

```sh
dsh plugin --profile web update dsh-experimental-agent-codex
```

请对每个受影响的 profile 执行更新。固定 commit 的安装需要将 pin 移到已修复的 commit。

### 找不到 Codex 可执行文件

在启动 `dsh` 的同一环境中运行 `codex --version`。如果 Codex 不在 `PATH` 中，请配置绝对 `command` 路径。

### 认证或授权失败

直接运行 Codex 并修复用户自己的登录。选择通过 `OPENAI_API_KEY` 认证时，通过 `env` 显式转发。桥接器绝不会运行 `codex login`。

### App-server 拒绝参数

对已安装版本运行 `codex app-server --help`，然后覆盖 `args`。本仓库有意不固定用户的可执行文件。

### 已注册第二个 AgentFactory

检查 `dsh --profile <name> --dump-config`，只保留一个注册 AgentFactory 的行。

## 卸载

```sh
dsh plugin --profile web remove dsh-experimental-agent-codex
```

重启 profile。Base bundle 中更早的 `@deepseek-ai/dsh-agent-loop` 行会重新生效。卸载本桥接器不会删除 Codex、退出登录或删除 `CODEX_HOME`。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
```

每次修改 runtime 源码时，都要提交重新生成的 `lib/` 文件，使 GitHub 直接安装无需 build script。

## 许可证

[MIT](LICENSE)
