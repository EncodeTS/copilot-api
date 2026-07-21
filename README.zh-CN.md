# Copilot API Proxy

[English](./README.md) | 简体中文

## EncodeTS Fork 说明

本仓库由 EncodeTS 独立维护，最初 fork 自 [caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api)。项目不再以上游一致性为目标，后续会按自身需求主动演进。

本 fork 的差异：

- 桌面安装包发布在 [本 fork 的 GitHub Releases](https://github.com/EncodeTS/copilot-api/releases)。
- Messages API 请求会保留客户端指定的模型和 `tool_result` 边界；无工具预热请求不会再被静默改写到回退模型。
- 在兼容前提下保留并规范化客户端传入的 `thinking` / `effort`，并对 provider stream error 做了小幅健壮性修正。

本 fork 的 CLI 发布在 npm 的 `@encodets/copilot-api` scope 下。预发布版本使用 `rc` dist-tag，稳定版本使用 `latest`。

## 重要说明

> [!IMPORTANT]
> **使用前请先注意以下几点：**
>
> 1. **Claude Code 配置：** 与 Claude Code 搭配使用时，请将模型 ID 配置为 `claude-opus-4-8`。示例 claude `settings.json` 见 [通过 `settings.json` 手动配置](#manual-configuration-with-settingsjson)。
> 2. **内置 `copilot`、`codex` 与第三方 provider：** 执行 `npx @encodets/copilot-api@rc auth`，可选择 `copilot`、`codex`、`deepseek`、`custom` 等 provider。
> 3. **注意事项：** README 顶部移除的 GitHub Copilot warning 见 [GitHub Copilot 安全提示](./NOTICE.md#github-copilot-security-notice)。

---

## 项目概览

这是一个小型 AI gateway，可以使用 GitHub Copilot、内置 `codex` provider，也可以使用 DashScope 等已配置的第三方 provider。GitHub Copilot 现在是可选能力：如果本地没有 GitHub token，只要至少配置了一个启用中的 provider，服务仍可按 provider-only 模式启动。

AI gateway 会从同一个本地端点暴露 OpenAI / Anthropic 兼容 API，让 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)、OpenCode、Codex 和 OpenAI 兼容客户端可以共用同一个本地服务。

在 GitHub Copilot 路径上，AI gateway 会在可用时优先使用 Copilot 原生的 Anthropic 风格 Messages API，在重工具调用场景下保留更原生的 Claude 行为。

## 功能特性

- **OpenAI 与 Anthropic 双兼容**：通过 `/v1/responses`、`/v1/chat/completions`、`/v1/models`、`/v1/embeddings` 和 `/v1/messages` 对外暴露同一个本地 AI gateway。
- **Copilot 可选**：有 GitHub 凭据时可以使用 GitHub Copilot，没有 GitHub 凭据时也可以只依赖已配置的 provider 运行。
- **同一网关接入 Copilot、`codex` 与第三方 provider**：可统一路由 GitHub Copilot、内置 `codex` provider 和配置好的外部 provider。
- **第三方 provider 可独立启动**：配置 DashScope、DeepSeek、OpenRouter 或自定义 provider 后，不需要 GitHub Copilot 登录即可启动 AI gateway。
- **OpenAI 兼容 provider 同时支持 chat 和 Messages API**：`openai-compatible` provider 可通过顶层 `/v1/chat/completions` 搭配 `model: "provider/model"` 提供 Chat Completions，也可通过 `/v1/messages` 完成 Anthropic Messages 的请求/响应翻译。
- **面向 Claude 的更原生 Copilot 路由**：优先使用原生 `/v1/messages`，保留 Claude 风格工具流，支持 Anthropic beta 能力、通过 Responses-capable 模型支持 Claude WebSearch，并保留 subagent / session 标记。
- **Claude Code 与 OpenCode 集成**：兼容 Claude Code 与 OpenCode，也支持通过 `@ai-sdk/anthropic` 直接作为 Anthropic provider 使用。
- **灵活的认证与部署选项**：支持交互式登录、直接 token、个人 / Business / Enterprise、GitHub Enterprise、opencode OAuth 和自定义数据目录。
- **多 provider 路由**：可暴露 `/:provider/...` 路由，也可在顶层 API 上使用 `model: "provider/model"`。

## 前置要求

- Bun（>= 1.2.x）
- 如果要通过 `npx` 运行已发布 CLI，需要 Node.js
- 只有在使用 GitHub Copilot provider 时，才需要已订阅 Copilot 的 GitHub 账号
- 如果不使用 GitHub Copilot，需要至少一个已配置 provider 的 API key 或 OAuth 登录

## 安装

安装依赖：

```sh
bun install
```

直接从源码启动服务：

```sh
bun run start start
```

## 从源码运行

本项目可以通过多种方式从源码运行：

### 开发模式

```sh
bun run dev start
```

### 生产模式

```sh
bun run start start
```

## 通过 npx 使用

你可以直接用 npx 运行本项目：

> [!IMPORTANT]
> 通过 `npx` 运行时，token usage 存储会使用 Node 内置的 `node:sqlite` 模块。该能力会在 Node.js >= 22.13.0 时启用；Node.js < 22.13.0 时 CLI 仍可启动，但会禁用 token usage 存储。
>
> 如果不升级 Node.js 但仍需要 token usage 存储，可以改用 Bun 运行已发布 CLI：`bunx --bun @encodets/copilot-api@rc start`。

```sh
npx @encodets/copilot-api@rc start
```

带参数示例：

```sh
npx @encodets/copilot-api@rc start --port 8080
```

如果只想做认证或 provider 配置：

```sh
npx @encodets/copilot-api@rc auth
```

如果要不依赖 GitHub Copilot 运行，先配置至少一个 provider，然后正常启动服务：

```sh
npx @encodets/copilot-api@rc auth login --provider dashscope
npx @encodets/copilot-api@rc start
```

## 配合 Docker 使用

构建镜像：

```sh
docker build -t copilot-api .
```

通过 bind mount 运行容器，让认证数据在重启后保留：

```sh
mkdir -p ./copilot-data
docker run -p 4141:4141 -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api
```

这会把宿主机上的 `./copilot-data` 映射到容器内的 `/root/.local/share/copilot-api`，用于持久化 GitHub 认证数据、provider 配置和其他 gateway 状态。

也可以直接通过环境变量传入 GitHub token：

```sh
docker run -p 4141:4141 -e GH_TOKEN=your_github_token_here copilot-api
```

## Electron 桌面应用

如果你更喜欢图形界面，仓库里还提供了位于 `desktop/` 的 Electron 桌面应用。它支持 GitHub Copilot 登录、OpenAI Codex OAuth，以及 DeepSeek、DashScope、OpenRouter 或自定义 provider 的 API Key 配置。授权或配置 provider 后，可以一键启动或停止本地代理，并在界面里直接查看本地端点、鉴权 Header、可用模型、额度和日志。

设置页还可以配置 `OAuth App`、`API Home`、`Enterprise URL`、详细日志以及最小化到托盘。本 fork 的桌面安装包发布在 GitHub Releases：

handler 日志使用私有权限（目录 `0700`，所有新建或已打开的文件 `0600`）。详细日志默认只记录不含内容的结构化摘要；在数据存在时保留事件类型、模型、条目数量、payload 字节数和错误码，但不写入提示词、消息文本、工具输入/输出、推理、加密内容或签名。RC9 管理的新日志按天使用 `*.part-N.log` 命名，保留 7 天，单文件达到 10 MiB 时轮转，并按最旧优先将受管日志总量限制在 100 MiB。异步内存队列最多保留 5 MiB；磁盘持续故障时会在达到边界后丢弃新的日志条目，而不是继续无限增长。可通过 `COPILOT_API_LOG_MAX_BUFFER_BYTES`、`COPILOT_API_LOG_MAX_FILE_BYTES` 和 `COPILOT_API_LOG_MAX_TOTAL_BYTES` 调整字节上限。

RC9 之前生成的旧格式 handler 日志（`*-YYYY-MM-DD.log`）以及无关的 archive/private-audit 文件会原样保留，也不会计入自动保留期和总量清理。待需要保存的排障证据另行备份后，再手动决定是否删除这些旧文件。

仅在短时本地排障确有需要时，可在开启详细日志的同时显式设置 `COPILOT_API_LOG_FULL_PAYLOADS=1`，以记录 payload 内容。即使开启该选项，credential 字段、Authorization/Cookie、Bearer token、URL 签名参数以及媒体正文/地址仍会脱敏。完整 payload 日志仍可能包含私人提示词和模型/工具输出，排障结束后应立即关闭该选项。

https://github.com/EncodeTS/copilot-api/releases

Apple Silicon Mac 请选择 `*-arm64.dmg`，Intel Mac 请选择 `*-x64.dmg`。本 fork 的桌面构建是 unsigned/ad-hoc signed，未经过 notarization。

下载对应平台的安装包后，在应用内授权或配置 provider，选择端口并启动服务，再把你的客户端指向应用里显示的本地端点即可。发布版桌面应用使用随包内置的 Electron 运行时，正常使用不需要额外安装 Node.js；token usage 历史记录会在该内置运行时支持 SQLite 时启用。

桌面应用里的高级配置页会通过 `GET/POST /admin/config/model-mappings` 读写这份共享的模型映射。同一份映射会统一作用于 `POST /v1/messages`、`POST /v1/messages/count_tokens`、`POST /v1/responses` 和 `POST /v1/chat/completions`，不再按接口区分。它使用的是 `auth.adminApiKey`，不是普通的 `auth.apiKeys`；应用会在服务启动并自动生成该 key 后，直接从 `config.json` 读取它来发起请求。

### 桌面应用截图

下面展示了桌面应用中的首页、Token 用量统计页面：

<p align="center">
  <img src="./docs/screenshots/desktop-dashboard.png" alt="Copilot API 桌面应用首页" width="49%" />
  <img src="./docs/screenshots/desktop-token-usage.png" alt="Copilot API 桌面应用 Token 用量页" width="49%" />
</p>

## 与 Claude Code 一起使用

这个 AI gateway 可以为 [Claude Code](https://docs.anthropic.com/en/claude-code) 提供后端能力。Claude Code 是 Anthropic 提供的实验性面向开发者的对话式 AI 助手。

有两种方式可以把 Claude Code 配置为使用这个 AI gateway：

### 通过 `--claude-code` 标志进行交互式配置

执行带 `--claude-code` 的 `start` 命令开始：

```sh
npx @encodets/copilot-api@rc start --claude-code
```

你会被提示选择一个主模型，以及一个用于后台任务的 "small, fast" 模型。选择完成后，会有一条命令被复制到剪贴板中。该命令会设置 Claude Code 使用这个 AI gateway 所需的环境变量。

在新的终端中粘贴并执行这条命令，即可启动 Claude Code。

<a id="manual-configuration-with-settingsjson"></a>

### 通过 `settings.json` 手动配置

另一种方式是在项目根目录中创建 `.claude/settings.json` 文件，并写入 Claude Code 所需的环境变量。这样你就不需要每次都运行交互式配置了。

下面是一个 `.claude/settings.json` 示例：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "deepseek/deepseek-v4-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek/deepseek-v4-pro",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek/deepseek-v4-flash",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "false",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "true",
    "CLAUDE_CODE_ENABLE_AWAY_SUMMARY": "0"
  }
}
```

- 请根据需要替换 `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL` 和 `ANTHROPIC_DEFAULT_HAIKU_MODEL`。配置完成后，请安装 claude code 插件，见 [插件集成](#plugin-integrations)。
- 将 `CLAUDE_CODE_ATTRIBUTION_HEADER` 设为 `0` 可以阻止 Claude Code 在 system prompt 中附加计费和版本信息，从而避免 prompt cache 失效。
- 关闭 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` 和 `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` 可以避免不必要地消耗额度。
- Claude Code WebSearch 已支持纯搜索请求。Copilot 路径请保持全局 `messageApiWebSearchModel` 指向 Responses-capable GPT 模型或 `provider/model` 别名；provider 路由请使用原生 Anthropic provider 或 `openai-responses` provider。只有在你明确想禁止这类流量时，才需要把 `WebSearch` 加到 `permissions.deny`。
- `mcp__ide__executeCode` 会按能力处理：当所选模型支持原生 Messages 或 Responses 路由时，网关会保留该工具，包括强制指定该工具的选择；Chat Completions fallback 会过滤 eager 工具，并拒绝强制指定它的请求。只有在你明确要对所有模型禁用 IDE 代码执行时，才需要把它加入 `permissions.deny`。
- 如果使用的不是 Claude 模型，请不要启用 `ENABLE_TOOL_SEARCH`。如果使用的是 Claude 模型，则可以启用 `ENABLE_TOOL_SEARCH`。当前 Claude Code 使用的是客户端 tool search 模式，在该模式下每次加载 defer tools 都需要额外请求一次。
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW`：设置用于自动压缩计算的上下文容量（以 token 为单位）。默认使用模型自身的上下文窗口：标准模型为 200K，扩展上下文模型为 1M。使用 1M 上下文模型（如 `claude-opus-4-6[1m]`）时，可设置一个较低的值（如 `500000`）将窗口视为 500K 用于压缩计算。该值受限于模型的实际上下文窗口上限。`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 会基于此值的百分比生效。设置此变量可将压缩阈值与状态栏的 `used_percentage` 解耦（后者始终使用模型的完整上下文窗口）。

更多选项见：[Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

也可以参考 IDE 集成说明：[Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

## 与 OpenCode 一起使用

OpenCode 已经有直接的 GitHub Copilot provider。本节适用于你希望让 OpenCode 通过 `@ai-sdk/anthropic` 指向这个 AI gateway，并复用本 README 前面提到的 agent 行为时。

### 最小配置

使用 OpenCode OAuth app 启动 AI gateway：

```sh
npx @encodets/copilot-api@rc auth --oauth-app=opencode
npx @encodets/copilot-api@rc start
```

然后让 OpenCode 通过 `@ai-sdk/anthropic` 指向这个 AI gateway。

示例 `~/.config/opencode/opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "local": {
      "npm": "@ai-sdk/anthropic",
      "name": "My Local",
      "options": {
        "baseURL": "http://localhost:4141/v1",
        "apiKey": "dummy"
      },
      "models": {
        "gpt-5.4": {
          "name": "gpt-5.4",
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": {
            "context": 400000,
            "input": 272000,
            "output": 128000
          }
        },
        "claude-sonnet-4.6": {
          "id": "claude-sonnet-4.6",
          "name": "claude-sonnet-4.6",
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": {
            "context": 200000,
            "output": 32000
          },
          "options": {
            "thinking": {
              "type": "adaptive"
            },
            "effort": "max"
          }
        }
      }
    }
  }
}
```

这些字段的重要性：

- `npm: "@ai-sdk/anthropic"` 是关键。OpenCode 会以 Anthropic Messages 语义与这个 AI gateway 通信，而不是把一切扁平化为 OpenAI Chat Completions。
- `options.baseURL` 应设为 `http://localhost:4141/v1`；Anthropic SDK 会自动补上 `/messages`、`/models` 和 `/messages/count_tokens`。
- 如果你在此代理中启用了 `auth.apiKeys`，请把 `dummy` 替换为真实 key；否则任意占位值都可以。

## 与 Codex 一起使用

这个 AI gateway 也可以为 Codex 提供后端能力。

### Codex `config.toml` 参考配置

把以下 `[model_providers.copilot_api]` 段加入你的 Codex `~/.codex/config.toml`：

```toml
model_provider = "copilot_api"
model_reasoning_summary = "auto"

[model_providers.copilot_api]
name = "OpenAI"
base_url = "http://localhost:4141"
supports_websockets = false
wire_api = "responses"
request_max_retries = 3
stream_max_retries = 1
stream_idle_timeout_ms = 300000

[model_providers.copilot_api.auth]
command = "node"
args = ["-e", "process.stdout.write(process.env.GITHUB_COPILOT_API_KEY || 'dummy')"]
timeout_ms = 5000
refresh_interval_ms = 300000

[features]
remote_compaction_v2 = true

[analytics]
enabled = false
```

Windows 没有安装 Node.js 时，只需把上面的
`[model_providers.copilot_api.auth]` 表替换为下面这份兼容 Windows
PowerShell 5.1/7 的命令：

```toml
[model_providers.copilot_api.auth]
command = "powershell.exe"
args = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$v=$env:GITHUB_COPILOT_API_KEY; if ([string]::IsNullOrWhiteSpace($v)) { $v='dummy' }; [Console]::Out.Write($v)"
]
timeout_ms = 5000
refresh_interval_ms = 300000
```

如果明确希望使用 PowerShell 7，请把 `powershell.exe` 改成 `pwsh.exe`。

> [!NOTE]
> 此配置仅限于 Codex 与 GitHub Copilot provider。`name` 一定要配置为 `"OpenAI"`。这里有意使用 command auth：当前 Codex 只会为 command auth 的自定义 provider 刷新 `/models`；若配置的 base URL 已包含 `/v1`，对应路径则为 `/v1/models`。命令会优先输出 `GITHUB_COPILOT_API_KEY`；若 gateway 没启用 API Key 鉴权，则输出占位值 `dummy`。Command auth 与 `env_key`、`experimental_bearer_token`、`requires_openai_auth` 互斥；请删除这些字段，不要组合多种鉴权。不要再硬编码 `model_context_window` 或 `model_auto_compact_token_limit`：gateway 会读取本机同版本 Codex 的 bundled catalog，再只覆盖 Copilot 官方实时返回的上下文能力。若找不到同版本 Codex 可执行文件，gateway 会返回空的远端 catalog，让 Codex 安全保留自己的内置模型定义。只有可执行文件不在常见位置时，才需要设置 `COPILOT_API_CODEX_CLI_PATH`。

## GPT Tool Search

对于 `gpt-5.4+` 这类 GPT Responses 模型，这个 AI gateway 可以通过一个很小的 MCP bridge 暴露 Responses `tool_search`。Claude Code 和 opencode 都可以使用同一个 bridge，前提是客户端会加载 MCP server，并且 Anthropic Messages 流量会经过这个 AI gateway。

GPT 模型不要设置 Claude Code 原生的 `ENABLE_TOOL_SEARCH`。这个开关启用的是 Claude Code 自己的客户端 tool search 模式，可能导致 deferred 工具定义不再转发给 AI gateway。这个 AI gateway 需要完整的工具定义，这样才能只保留那一小组常驻加载工具，其余工具统一转换为 Responses deferred namespace。

如果你安装了 `tool-search@copilot-api-marketplace`，Claude Code 会自动带上这个 MCP bridge，可以跳过下面这段 Claude Code MCP 手动配置。

请把 tool search bridge 加到 Claude Code 使用的 MCP 配置中：

```json
{
  "mcpServers": {
    "tool_search": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@encodets/copilot-api@rc", "mcp"]
    }
  }
}
```

请把 tool search bridge 加到 opencode 使用的 MCP 配置中：

```json
{
  "mcp": {
    "tool_search": {
      "type": "local",
      "command": ["npx", "-y", "@encodets/copilot-api@rc", "mcp"]
    }
  }
}
```

本地开发时可以将命令换成 `bun`，参数换成 `["run", "./src/main.ts", "mcp"]`。

AI gateway 内部现在会把 OpenAI Responses `tool_search` 配置成 client-executed 模式。deferred tools 仍然会作为可搜索 namespace 暴露给模型，但会明确要求模型直接返回下一步要加载的精确工具名列表。

该 bridge 使用直接工具选择，不做 query 搜索。工具入参是 `names`，值为逗号分隔的精确 deferred 工具名，例如 `TaskList,TaskGet,mcp__fetch__fetch`。

<a id="plugin-integrations"></a>

## 插件集成

本项目为 Claude Code 和 opencode 提供了插件集成。

#### Claude Code 插件集成（基于 marketplace）

Claude Code 集成现在拆分为两个插件：

- `agent-inject` 会在 `SubagentStart` 时注入 `__SUBAGENT_MARKER__...`，以便 AI gateway 推导 `x-initiator: agent`。
- `tool-search` 会注册用于 GPT Responses deferred tool loading 的 `tool_search` MCP bridge。

- 本仓库中的 marketplace catalog：`.claude-plugin/marketplace.json`
- 本仓库中的插件源码：`plugin/claude/agent-inject`、`plugin/claude/tool-search`

远程添加 marketplace：

```sh
/plugin marketplace add https://github.com/EncodeTS/copilot-api.git
```

从 marketplace 安装插件：

```sh
/plugin install agent-inject@copilot-api-marketplace
/plugin install tool-search@copilot-api-marketplace
```

安装后，`agent-inject` 会在 `SubagentStart` 时注入 `__SUBAGENT_MARKER__...`，AI gateway 会利用它推导 `x-initiator: agent`。

`agent-inject` 还会注册一个 `UserPromptSubmit` hook，并返回 `{"continue": true}`；同时它也可以通过环境变量注入 `SessionStart` reminder 规则：

- `CLAUDE_PLUGIN_ENABLE_QUESTION_RULES=1` 会自动为 Claude Code 启用两条关于使用 `question` 工具的提醒。你也可以把同样的提醒手动写进 `CLAUDE.md`；见 [CLAUDE.md 或 AGENTS.md 推荐内容](#claudemd-or-agentsmd-recommended-content)。
- `CLAUDE_PLUGIN_ENABLE_NO_BACKGROUND_AGENTS_RULE=1` 会启用关于避免在 agent hooks 中使用 `run_in_background: true` 的提醒。

`tool-search` 插件内置了 [GPT Tool Search](#gpt-tool-search) 一节描述的同一个 MCP bridge，因此安装该插件后，Claude Code 用户无需再手动配置 `tool_search` server。

#### Opencode 插件

subagent 标记生成器被打包为一个 opencode 插件，位于 `plugin/opencode/subagent-marker.js`。

**安装方式：**

将插件文件复制到你的 opencode 插件目录：

```sh
# 克隆或下载本仓库后复制该插件
cp plugin/opencode/subagent-marker.js ~/.config/opencode/plugins/
```

或者手动在 `~/.config/opencode/plugins/subagent-marker.js` 创建该文件，并填入插件内容。

**功能：**

- 跟踪 subagent 创建的子会话
- 自动在 subagent 聊天消息前添加 marker system reminder（`__SUBAGENT_MARKER__...`）
- 设置 `x-session-id` 请求头以跟踪会话
- 让这个 AI gateway 能够把来自 subagent 的请求识别为 `x-initiator: agent`

该插件会挂接到 `session.created`、`session.deleted`、`chat.message` 和 `chat.headers` 事件上，以无缝提供 subagent marker 能力。

## 使用量查看器

服务启动后，控制台会输出一个 Copilot 使用量看板 URL。这个看板是一个用于监控 API 用量的 Web 界面。

1. 启动服务。例如使用 npx：
   ```sh
   npx @encodets/copilot-api@rc start
   ```
2. 服务会输出一个 usage viewer 的 URL。将它复制到浏览器中打开，形式大致如下：
   `http://localhost:4141/usage-viewer?endpoint=http://localhost:4141/usage`
   - 如果你在 Windows 上使用 `start.bat` 脚本，这个页面会自动打开。

看板提供了更易读的 Copilot 用量视图：

> token usage 历史记录需要 Bun 或 Node.js >= 22.13.0。Node.js < 22.13.0 时服务会正常运行，但 token usage 存储会被禁用。

- **API Endpoint URL**：通过 URL 查询参数指定 API endpoints，默认指向本地服务。支持手动切换为其他兼容 endpoints。
- **x-api-key 认证**：如果启用了 API Key 认证，可填入 `x-api-key` 请求头。密钥会持久化保存在浏览器本地存储中。
- **Period 选择器**：支持 Day / Week / Month 三种时间范围，切换时 URL 参数会自动同步，方便收藏和分享。
- **Fetch Data**：点击 "Refresh" 按钮加载或刷新使用数据。页面加载时也会自动拉取数据。
- **Copilot Quotas 额度**：通过进度条展示 Chat、Completions 等不同服务的额度使用情况，悬停可查看已用/剩余详情。
- **Token Usage 指标卡片**：汇总当前周期的 Total、Input、Output、Cache Read、Cache Write、Requests 和预估费用。
- **趋势图（Week / Month）**：提供按模型和指标筛选的折线趋势图，点击数据点可查看单日用量明细。
- **Model Breakdown 表格**：按模型维度列出周期内的请求数、输入/输出/缓存 token 和预计费用。
- **Request Events 分页列表**：按时间排序的请求事件记录，支持分页浏览，含时间戳、模型、请求 ID 和 token 用量。
- **Detailed Information**：展示 API 返回的完整 JSON 响应，便于深入分析所有可用统计数据。
- **URL-based Configuration**：也可通过 `endpoint` 和 `period` 查询参数直接指定 API 端点与时间范围。例如：
  `http://localhost:4141/usage-viewer?endpoint=http://your-api-server/usage&period=week`

### Usage Viewer 截图

<p align="center">
  <img src="./docs/screenshots/usage-viewer.png" alt="Copilot API Usage Viewer 页面" width="900" />
</p>

## 命令结构

Copilot API 现在使用子命令结构，主要命令包括：

- `start`：启动 AI gateway 服务。如果已有 GitHub token，则启用 Copilot 路径；如果没有 GitHub token，但存在至少一个启用中的 provider，则按 provider-only 模式启动；如果两者都没有，会引导你配置 provider。
- `auth`：仅执行 provider 登录或配置流程，不启动服务。可用于 GitHub Copilot 登录、Codex OAuth，或第三方 provider API key 配置。
- `debug`：显示诊断信息，包括版本、运行时详情、文件路径以及认证状态，便于排障与支持。

## 命令行选项

### 全局选项

以下选项可用于任意子命令。若在子命令之前传入，请使用 `--key=value` 形式：

| 选项             | 说明                                                       | 默认值 | 别名 |
| ---------------- | ---------------------------------------------------------- | ------ | ---- |
| --api-home       | API home 目录路径（设置 `COPILOT_API_HOME`）               | 无     | 无   |
| --oauth-app      | OAuth app 标识符（设置 `COPILOT_API_OAUTH_APP`）           | 无     | 无   |
| --enterprise-url | GitHub Enterprise URL（设置 `COPILOT_API_ENTERPRISE_URL`） | 无     | 无   |

### Start 命令选项

以下是 `start` 命令可用的命令行选项：

| 选项           | 说明                                                 | 默认值 | 别名 |
| -------------- | ---------------------------------------------------- | ------ | ---- |
| --port         | 监听端口                                             | 4141   | -p   |
| --verbose      | 启用结构化诊断日志（默认省略 payload 内容）          | false  | -v   |
| --github-token | 直接提供 GitHub token（必须通过 `auth` 子命令生成）  | 无     | -g   |
| --claude-code  | 生成一个使用 Copilot API 配置启动 Claude Code 的命令 | false  | -c   |
| --show-token   | 在获取和刷新时显示 GitHub 与 Copilot token           | false  | 无   |
| --proxy-env    | 从环境变量初始化代理                                 | false  | 无   |

### Auth 命令选项

| 选项         | 说明                                                                                                            | 默认值   | 别名 |
| ------------ | --------------------------------------------------------------------------------------------------------------- | -------- | ---- |
| --provider   | 要登录或配置的 provider（`copilot`、`codex`、`opencode-go`、`deepseek`、`dashscope`、`openrouter` 或 `custom`） | 交互选择 | 无   |
| --verbose    | 启用结构化诊断日志（默认省略 payload 内容）                                                                     | false    | -v   |
| --show-token | 认证时显示 GitHub token                                                                                         | false    | 无   |

只有在需要启用 GitHub Copilot provider 时，才需要执行 `copilot-api auth login --provider copilot`。使用 `codex` 或第三方 provider-only 模式不要求配置 Copilot。

使用 `copilot-api auth login --provider deepseek`、`--provider dashscope`、`--provider openrouter` 或 `--provider opencode-go` 可以通过 CLI 快速新增或更新这些常用第三方 provider。DeepSeek 会提示输入掩码显示的 `apiKey`、provider `type`（默认 `anthropic`），以及默认 `https://api.deepseek.com/anthropic` 的 `baseUrl`。DashScope 会提示输入掩码显示的 `apiKey`、provider `type`（默认 `openai-compatible`）和预填默认值的 `baseUrl`。OpenRouter 只提示输入掩码显示的 `apiKey` 和预填默认值的 `baseUrl`，并固定写入 `type: "anthropic"`。OpenCode Go 只提示输入掩码显示的 `apiKey` 和预填默认值的 `baseUrl`，并固定写入 `type: "openai-compatible"`（baseUrl `https://opencode.ai/zen/go`）。配置并启用 provider 后，`copilot-api start` 可在没有 GitHub token 的情况下启动。

使用 `copilot-api auth login --provider custom` 可以通过 CLI 新增或更新其他第三方 provider。命令会依次提示输入 provider name、项目支持的 type（`anthropic`、`openai-compatible` 或 `openai-responses`）、`baseUrl`、掩码显示的 `apiKey` 和 `authType`；`authType` 可保持 type 默认值，也可选择 `x-api-key` / `authorization`。

### Debug 命令选项

| 选项   | 说明                 | 默认值 | 别名 |
| ------ | -------------------- | ------ | ---- |
| --json | 以 JSON 输出调试信息 | false  | 无   |

<a id="configuration-configjson"></a>

## 配置（config.json）

- **位置：** Linux/macOS 为 `~/.local/share/copilot-api/config.json`，Windows 为 `%USERPROFILE%\.local\share\copilot-api\config.json`。
- **默认结构：**
  ```json
  {
    "auth": {
      "apiKeys": [],
      "adminApiKey": "<startup 自动生成>"
    },
    "providers": {},
    "modelMappings": {},
    "extraPrompts": {
      "gpt-5-mini": "<built-in exploration prompt>"
    },
    "contextManagement": {
      "messages": false,
      "responses": false
    },
    "modelReasoningEfforts": {
      "gpt-5-mini": "low"
    },
    "useMessagesApi": true,
    "useResponsesApiWebSocket": true,
    "useResponsesApiWebSearch": true,
    "messageApiWebSearchModel": "gpt-5-mini"
  }
  ```
- **auth.apiKeys：** 用于普通非 admin 路由的 API key。支持多个 key 轮换使用。请求可通过 `x-api-key: <key>` 或 `Authorization: Bearer <key>` 进行认证。若为空或省略，则普通路由的认证会被禁用。
- **auth.adminApiKey：** 仅用于 `/admin/*` 路由的单个 admin key。若未配置，服务会在启动时自动生成一个随机 key，并回写到 `config.json`。它同样使用 `x-api-key` 或 `Authorization: Bearer` 这两种头，但普通 `auth.apiKeys` 不能访问 `/admin/*`。
- **modelMappings：** 用于顶层 `POST /v1/messages`、`POST /v1/messages/count_tokens`、`POST /v1/responses` 和 `POST /v1/chat/completions` 请求的精确 `sourceModel -> targetModel` 重写映射，这几类接口共用同一份规则。省略该字段或保留为 `{}` 时，不会做模型重写。`source` 和 `target` 都必须是非空字符串。`target` 可以是普通模型 ID，也可以是 `provider/model` 形式的别名，例如 `dashscope/qwen3.6-plus`；重写发生在 provider alias 解析之前。这些映射不再按接口区分。`GET/POST /admin/config/model-mappings` 管理接口读写的也只有这个字段。
- **extraPrompts：** `model -> prompt` 的映射。把 Anthropic 风格请求翻译为 Responses API 时，会将其附加到第一条 system prompt 后面。你可以借此为不同模型注入护栏或指引。缺失的默认项会自动补齐，但不会覆盖你自定义的 prompt。对于 GPT-5.3+ 模型（如 `gpt-5.3-codex`、`gpt-5.4`、`gpt-5.5`），未显式配置时会自动使用内置的 commentary prompt。内置 prompt 会启用带阶段感知的 commentary，让模型在工具调用或更深层推理前先发出简短的用户可见进度说明。
- **providers：** 全局上游 provider 映射。每个 provider key（例如 `dashscope`）都会变成一个路由前缀（`/dashscope/v1/messages`）。支持 `type: "anthropic"`、`type: "openai-compatible"` 和 `type: "openai-responses"`。顶层客户端也可以在 `/v1/messages`、`/v1/messages/count_tokens`、`/v1/responses` 和 `/v1/chat/completions` 中使用 `model: "dashscope/model-id"`；AI gateway 会在转发上游前移除 `dashscope/` 前缀。`openai-compatible` provider 同时支持 chat 和 Messages 流程：`/v1/chat/completions` 会直连上游 `/v1/chat/completions`，而 `/v1/messages` 和 `/:provider/v1/messages` 会先翻译为上游 Chat Completions，再把响应翻译回 Anthropic Messages。`openai-responses` provider 还可以直接通过 `POST /:provider/v1/responses` 调用；该 provider-scoped 路由中的模型应使用不带 `provider/` 前缀的上游模型 ID。`GET /v1/models` 会聚合已启用 provider 的模型，并以 `provider/model-id` 形式返回；单个 provider 的原始模型列表仍可使用 `GET /dashscope/v1/models`。
  - `enabled`：可选，若省略则默认为 `true`。
  - `baseUrl`：provider API 的基础 URL，不要带结尾的 endpoint。Anthropic provider 不要带 `/v1/messages`；OpenAI 兼容 provider 不要带 `/v1/chat/completions`；OpenAI Responses provider 不要带 `/v1/responses`。
  - `apiKey`：作为上游凭据值使用；普通 provider 必须配置。
  - `authType`：可选，控制 `apiKey` 如何发送到上游。普通 provider 支持 `x-api-key` 和 `authorization`。Anthropic provider 默认 `x-api-key`；OpenAI 兼容和 OpenAI Responses provider 默认 `authorization`。当设置为 `authorization` 时，代理会发送 `Authorization: Bearer <apiKey>`。`oauth2` 仅保留给内置 `codex` provider，并由 `auth login --provider codex` 自动写入。
  - `capabilities.responsesContextManagement`：可选。只有确认 OpenAI Responses provider 支持 `context_management` 压缩扩展时才设为 `true`。普通第三方 provider 默认关闭；内置 Copilot 和 Codex 视为已知支持。
  - `pricingCurrency`：可选，provider 维度的 token 费用币种，例如 `USD` 或 `CNY`。快捷 provider 默认 DashScope、DeepSeek 为 `CNY`，Codex/OpenRouter 为 `USD`。费用按币种分别汇总，不做汇率换算。
  - `models`：可选，按模型 ID 配置的映射。每个键为请求中的模型名，值支持：
    - `temperature`：可选，当请求未指定时使用的默认温度。
    - `topP`：可选，当请求未指定时使用的默认 `top_p`。
    - `topK`：可选，当请求未指定时使用的默认 `top_k`。
    - `extraBody`：可选，按模型合入上游请求体的动态字段；请求体显式同名字段优先。OpenAI 兼容 provider 可用它配置 `enable_thinking`、`preserve_thinking`、`reasoning_effort` 等字段。`thinking_budget` 是 OpenAI 兼容 provider 的特殊覆盖项：配置在 `extraBody` 后，会在 Anthropic `thinking.budget_tokens` 翻译之后强制写入，并覆盖请求派生出的预算值。对于 provider name 为 `dashscope` 或 `baseUrl` 包含 `aliyuncs.com` 的 provider，请求派生的 `thinking_budget`（来自 Anthropic `thinking.budget_tokens`）会转发给上游；其他 OpenAI 兼容 provider 会移除请求派生的 `thinking_budget`，但 `extraBody` 中的 `thinking_budget` 仍然生效。对于 DashScope provider，当 `preserve_thinking` 未在 `extraBody` 或请求体中显式设置时，默认为 `true`。
    - `pricing`：可选，按模型配置 token 单价，币种使用 provider 的 `pricingCurrency`，单位为每 100 万 tokens。支持 `input`、`output`、`cachedInput`（隐式缓存读）、`explicitCachedInput`（显式缓存读）和 `cacheCreationInput`。如需按输入 token 总量分档，可用带 `maxInputTokens` 的 `tiers`。
    - `contextCache`：可选，provider name 为 `dashscope` 或 `baseUrl` 包含 `aliyuncs.com` 时默认 `true`，其他 OpenAI 兼容 provider 默认 `false`。用于启用阿里云百炼/DashScope 的显式缓存（explicit context cache），会按其 Context Cache 格式在最多 4 个 content block 上注入 `cache_control: { "type": "ephemeral" }`。缓存断点策略与 opencode 主链路保持一致：前 2 条 system 消息 + 最后 2 条非 system 消息。标记字符串 content 时会把 `system` / `user` / `assistant` / `tool` 消息转换为 text content part 数组；已有数组 content 则标记最后一个 part。如果模型本身已经支持隐式缓存，或上游不支持该显式缓存扩展字段，可在模型配置中设为 `false`。支持相同显式缓存扩展的非 DashScope provider 可设为 `true`。同时适用于 `/v1/messages` 和 `/v1/chat/completions` 路由。
    - `responsesContextManagement`：可选，按模型开启 Responses `context_management` 扩展。只影响当前模型；同一 provider 的其他模型保持关闭。
    - `supportPdf`：可选，控制该模型是否支持 PDF/document content。默认 `false`，不支持时会把 PDF 转成提示文本；设为 `true` 时会把 PDF/document 转成 OpenAI Chat Completions 的 file part。
    - `toolContentSupportType`：可选，配置该模型的 tool result content 支持能力，值为 `array`、`image`、`pdf` 的数组。provider 侧未配置时默认只发送 string tool content。若 `supportPdf` 为 `true` 但这里不包含 `pdf`，tool result 里的 file part 会被转成 user role 消息。Copilot 主链路不使用这个 provider 默认，仍按 array + image 且不支持 PDF 的能力处理。
    - `type`：可选，按模型覆盖 provider 的协议类型。支持 `anthropic`、`openai-compatible` 和 `openai-responses`。设置后，provider 的 `/v1/messages` 路由会使用该模型的 type 替代 provider 级别的 type 进行请求路由、认证头解析和上游端点选择。适用于 OpenCode Go 等上游对不同模型同时支持 OpenAI 兼容和 Anthropic Messages API 的 provider。覆盖 type 时，认证头按覆盖后 type 的默认值解析（Anthropic 默认 `x-api-key`；OpenAI 兼容/Responses 默认 `authorization`）。

  DashScope 模型配置示例：

  ```json
  {
    "providers": {
      "dashscope": {
        "type": "openai-compatible",
        "enabled": true,
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode",
        "apiKey": "sk-your-dashscope-key",
        "pricingCurrency": "CNY",
        "models": {
          "qwen3.7-plus": {
            "temperature": 1,
            "topP": 0.95,
            "topK": 20,
            "extraBody": {
              "preserve_thinking": true
            }
          },
          "glm-5.1": {
            "temperature": 0.7,
            "topP": 0.95,
            "contextCache": true,
            "pricing": {
              "tiers": [
                {
                  "maxInputTokens": 32000,
                  "input": 6,
                  "cachedInput": 1.2,
                  "explicitCachedInput": 0.6,
                  "cacheCreationInput": 7.5,
                  "output": 24
                },
                {
                  "maxInputTokens": 200000,
                  "input": 8,
                  "cachedInput": 1.6,
                  "explicitCachedInput": 0.8,
                  "cacheCreationInput": 10,
                  "output": 28
                }
              ]
            },
            "extraBody": {
              "preserve_thinking": true
            }
          }
        }
      }
    }
  }
  ```

  内置 token 价格覆盖 Codex GPT 模型（USD）、DashScope `qwen3.7-max`、`qwen3.7-plus`、`glm-5.1`、`glm-5.2`（CNY），DeepSeek `deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-chat`、`deepseek-reasoner`（CNY），以及 OpenCode Go 模型（`glm-5.2`、`deepseek-v4-flash`、`deepseek-v4-pro`、`kimi-k2.7-code`、`mimo-v2.5`、`mimo-v2.5-pro`、`qwen3.7-plus`、`qwen3.7-max`、`minimax-m2.5`、`minimax-m3`，USD）。用户配置的 `pricing` 优先于内置价格。DashScope 若上游 usage 中出现 `cache_creation_input_tokens` 字段，cached tokens 按显式缓存读价计费；否则 `cachedInput` 作为隐式缓存读价。DeepSeek 的 `prompt_cache_hit_tokens` 会归入 cached input，`prompt_cache_miss_tokens` 会归入普通 input。

- **contextManagement：** 控制代理是否为 Responses API 附加 `context_management` 压缩指令。`messages` 作用于被翻译成 Responses API 的 Anthropic 风格 `/v1/messages` 请求，`responses` 作用于 native `/v1/responses` 流量。两者默认均为 `false`，因此除非显式开启网关压缩，否则会保留客户端自己的压缩控制。普通 `openai-responses` provider 只有在 provider 级 `capabilities.responsesContextManagement` 或模型级 `responsesContextManagement` 为 `true` 时才允许注入和裁剪。无版本旧配置若含 `messages: true`，磁盘值会保留，但运行时会暂时关闭并写入 `migrationState.contextManagementMessages` 警告；只有明确选择 gateway-managed compaction 后才应移除该 marker。
- **modelResponsesApiCompactThresholds：** 可选的按模型 Responses API `compact_threshold` 覆盖，仅在代理自动附加 `context_management` 时使用。显式值优先于动态计算。未配置时使用实时模型 limits：Messages bridge 按 `max_prompt_tokens` 的 90% 触发，并至少保留 32,000 个输入增长 token；缺少 `max_prompt_tokens` 时使用 `max_context_window_tokens - max_output_tokens`。原生 Responses 默认仍关闭中转压缩，显式启用时保留 80% 策略。历史版本自动写入的 `gpt-5.4` / `gpt-5.5 = 217600`，以及 `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna = 231200` 会在配置迁移时删除。
- **modelReasoningEfforts：** `/v1/messages` 请求的模型级默认推理强度。仅当请求没有传入 `output_config.effort` 时，该配置才会生效。
  - **优先级：** 请求中的 `output_config.effort` > `modelReasoningEfforts[model]` > 内置默认值（GPT-5.3+ 模型为 `xhigh`，其他模型为 `high`）。
  - **转发字段：** 走 Copilot 原生 Messages API 时，最终值写入 `output_config.effort`；转换为 Responses API 时，最终值写入 `reasoning.effort`。
  - **配置可选值：** `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。
- **useMessagesApi：** 当为 `true` 时，支持 Copilot 原生 `/v1/messages` 的 Claude 系模型会走 Messages API；否则回退到 `/chat/completions`。设为 `false` 可禁用 Messages API 路由，始终使用 `/chat/completions`。默认值为 `true`。
- **useResponsesApiWebSocket：** 当为 `true` 时，Responses API 请求会优先对声明了 `ws:/responses` 的模型使用 Copilot websocket transport；仅声明 `/responses` 的模型仍走 HTTP。设为 `false` 可禁用 websocket 路由，并在模型支持 `/responses` 时使用 HTTP `/responses`。默认值为 `true`。当请求带有稳定的 reasoning recovery session ID 时，空闲 WebSocket 只会在 token、model、session 与 subagent identity 均相同的范围内复用；缺少稳定 session 的请求仍按 request ID 隔离，并发请求始终使用独立 socket。
- **Responses WebSocket 资源上限：** 连接池是进程级且有硬边界。`responsesWebSocketGlobalConnectionLimit` 默认 `128`；`responsesWebSocketPerCapacityKeyConnectionLimit` 按上游 origin/account 指纹默认 `32`；`responsesWebSocketIdleConnectionLimit` 默认 `32`；`responsesWebSocketDedicatedConnectionLimit` 默认 `64`。LRU 只会淘汰 `requestCount=0` 的空闲池连接。`responsesWebSocketCapacityWaitMs` 默认 `250`，而且只允许在请求发送前等待；容量耗尽会返回 typed not-sent failure，底层连接池本身绝不会决定 HTTP fallback。`responsesWebSocketIdleTimeoutMs` 默认 `60000`。
  - 接收队列分别受 `responsesWebSocketMaxQueuedFrames`（`4096`）、`responsesWebSocketMaxFrameBytes`（`33554432`）和 `responsesWebSocketMaxQueuedBytes`（`67108864`）限制。字符串按 UTF-8 字节计算，二进制 frame 按 `byteLength` 计算。溢出时只关闭对应 socket（code `1009`），输出一次不含 frame 内容的 terminal error，并清理 pool、active 和 queue 计数。
  - `GET /admin/config/responses-websocket` 返回有效上限和不含内容的进程级计数。已知网络或代理变化后，可向 `POST /admin/config/responses-websocket/clear` 发送 `{"reason":"network_change"}` 或 `{"reason":"proxy_change"}`。普通 close/error 会自动移除自身连接；清池绝不会授权重试 sent-unknown 或 frame-seen 请求。
- **旧会话 reasoning 恢复：** 如果 Copilot 在重放加密 reasoning 时返回 `input item does not belong to this connection`，gateway 会只移除历史 `reasoning` 输入项，并通过 HTTP 重试一次。原始请求始终保持不变并先执行；其他错误不会触发重试，WebSocket 一旦已有任何 frame 转发给客户端也不会恢复重试。
  - 如果请求带有稳定 session ID，gateway 只会在进程内缓存被拒绝 reasoning 的 SHA-256 指纹。后续 turn 会预先移除这些已知不兼容项，同时保留新生成的 reasoning。缓存限制为 256 个 scope、每个 scope 2,048 个指纹、24 小时空闲 TTL；进程重启后可能需要重新学习一次。
- **Stream lifecycle 加固：** Responses stream failure 会被分类为 client cancellation、upstream disconnect 或 timeout，并通过不含敏感数据的 transport diagnostics 仅记录一次 `stream.lifecycle`。通用 HTTP fallback 严格受 WebSocket send state 约束：只有在 `send()` 前失败的 WebSocket attempt 才能 fallback 一次；WebSocket 在 `send()` 后发生的 failure，以及所有 HTTP transport failure，即使尚未产生首个 downstream event 也会直接终止，从而避免重复生成与重复计费。上面的旧会话精确 ownership error 仍可在尚未向客户端转发任何 WebSocket frame 时执行一次净化后的 HTTP recovery。
- **useResponsesApiWebSearch：** 当为 `true` 时，服务端会保留 Responses API 中 `type: "web_search"` 的工具并透传到上游。设为 `false` 则会从 `/responses` payload 中移除这些工具。默认值为 `true`。
- **messageApiWebSearchModel：** 顶层 Copilot `/v1/messages` 请求只包含 Anthropic 服务端 `web_search_*` 工具时使用的全局模型，默认值为 `gpt-5-mini`。如果该值是 `provider/model` 别名，请求会进入对应 provider 的 Messages API 路径，并在转发前移除 provider 前缀。对于 Copilot GPT 模型，web search 会通过 `/responses` 执行，同时把 Anthropic `max_uses` 映射为 Responses `max_tool_calls`。Copilot 原生 Messages 端点目前会拒绝 `web_search_20250305`、`web_search_20260209` 和 `web_search_20260318`，因此新版依赖 code execution 的 dynamic filtering 会明确降级为 Responses direct search；响应会返回 `x-copilot-api-web-search-mode: direct-fallback`，并通过 `x-copilot-api-web-search-downgrade` 列出逗号分隔的降级原因。显式 `allowed_callers: ["direct"]` 仍按直接搜索处理；按照 Anthropic 语义，direct call 即使设置 `response_inclusion: "excluded"` 也会返回完整结果 block。Responses fallback 会刻意省略 Anthropic 的不透明 `encrypted_content`，并返回 `x-copilot-api-web-search-carrier: synthetic-without-encrypted-content`；当前不宣称支持完整的多轮 carrier 保真。混合 `web_search` 与自定义工具仅会原样透传给原生 Anthropic provider；非原生适配器会在转发前返回结构化错误。
- **claudeTokenMultiplier：** 仅用于 Claude `/v1/messages/count_tokens` 的本地回退估算，默认值为 `1.15`。对于支持 Copilot 原生 Messages 接口的 Claude 模型，计数请求会使用与生成请求相同的最终 payload 和 Copilot token 交给 Copilot；只有该接口返回 `404` 或 `501` 时才回退到本地估算。
- **anthropicApiKey：** 已弃用的兼容配置。顶层 Claude `/v1/messages/count_tokens` 不再使用单独的 Anthropic credential，而是使用 Copilot 原生 Messages token counting 接口和当前 Copilot token。

编辑此文件后即可自定义 prompts，或替换为你自己的快速模型。修改完成后请重启服务（或重新执行命令），让缓存中的配置刷新生效。

## API 认证

- **受保护的普通路由：** 当配置了 `auth.apiKeys` 且非空时，除 `/`、`/usage-viewer` 和 `/usage-viewer/` 以外的普通路由都需要认证。
- **Admin 路由：** 所有 `/admin/*` 路由都要求 `auth.adminApiKey`。如果缺失，服务会在启动时自动生成并在开始提供服务前写回 `config.json`。
- **允许的认证头：**
  - `x-api-key: <your_key>`
  - `Authorization: Bearer <your_key>`
- **CORS 预检：** `OPTIONS` 请求始终允许。
- **未配置普通 key 时：** 普通路由仍可直接访问；但这条规则不适用于 `/admin/*`，后者只接受 `auth.adminApiKey`。

普通受保护路由的示例请求：

```sh
curl http://localhost:4141/v1/models \
  -H "x-api-key: your_api_key"
```

Admin 路由的示例请求：

```sh
curl http://localhost:4141/admin/config/model-mappings \
  -H "x-api-key: your_admin_api_key"
```

## API 端点

服务端提供多个 OpenAI / Anthropic 兼容端点。请求会根据所选模型和 `provider/model` 别名路由到 GitHub Copilot、内置 `codex` provider 或已配置的 provider。

### OpenAI 兼容端点

这些端点模拟 OpenAI API 结构。

| 端点                           | 方法   | 说明                                                                                                                                                                                           |
| ------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/responses`           | `POST` | OpenAI 中用于生成模型响应的高级接口。支持 `openai-responses` provider 的 `provider/model` 别名。                                                                                               |
| `POST /:provider/v1/responses` | `POST` | 将 Responses 请求直接代理到指定的 `openai-responses` provider。模型应使用不带 `provider/` 前缀的上游模型 ID。                                                                                  |
| `POST /v1/chat/completions`    | `POST` | 为给定聊天对话创建模型响应。支持 `openai-compatible` provider 的 `provider/model` 别名；目标 provider 已配置时可在没有 Copilot 的情况下使用。                                                  |
| `GET /v1/models`               | `GET`  | 列出 Copilot 模型以及已启用 provider 的 `provider/model-id` 模型。Codex 客户端会收到与自身版本匹配的 bundled descriptor，并叠加 Copilot 官方实时上下文能力；无法匹配时安全回退为空的远端列表。 |
| `POST /v1/embeddings`          | `POST` | 创建表示输入文本的向量嵌入。                                                                                                                                                                   |

### Codex 后端代理端点

这些端点要求已有可用的 Codex 登录态。每个端点同时提供无版本前缀和 `/v1` 两种路径。

| 端点                                                        | 方法   | 说明                                                                                                                                                                   |
| ----------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /alpha/search`<br>`POST /v1/alpha/search`             | `POST` | 将 JSON 请求体和查询参数透明转发到 Codex Alpha Search 上游。                                                                                                           |
| `POST /images/generations`<br>`POST /v1/images/generations` | `POST` | 将 JSON 图片生成请求转发到 Codex Images 上游。请求未携带 `Content-Type` 时，网关默认补充 `application/json`。                                                          |
| `POST /images/edits`<br>`POST /v1/images/edits`             | `POST` | 将图片编辑请求转发到 Codex Images 上游。请使用 `multipart/form-data`，并让 HTTP 客户端自动生成 `boundary`；网关会保留传入的 content type，并以流式方式转发上传请求体。 |

对于以上所有端点，网关都会使用当前 Codex 登录态覆盖客户端的 authorization 和 account header，保留查询参数及兼容的请求头，并返回上游状态码、响应头和响应体。

### Anthropic 兼容端点

这些端点设计为兼容 Anthropic Messages API。

| 端点                                       | 方法   | 说明                                                                                                                 |
| ------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/messages`                        | `POST` | 为给定对话创建模型响应。支持已配置 provider 的 `provider/model` 别名，包括通过 `openai-compatible` provider 做翻译。 |
| `POST /v1/messages/count_tokens`           | `POST` | 计算一组消息的 token 数。支持已配置 provider 的 `provider/model` 别名。                                              |
| `POST /:provider/v1/messages`              | `POST` | 将 Anthropic Messages 请求代理到已配置的 Anthropic provider，或翻译到 OpenAI 兼容 / OpenAI Responses provider。      |
| `GET /:provider/v1/models`                 | `GET`  | 将模型列表请求代理到已配置的 provider。                                                                              |
| `POST /:provider/v1/messages/count_tokens` | `POST` | 为 provider 路由请求在本地计算 token 数。                                                                            |

### 使用量监控端点

用于监控 Copilot 用量与额度的新端点。

| 端点         | 方法  | 说明                                    |
| ------------ | ----- | --------------------------------------- |
| `GET /usage` | `GET` | 获取详细的 Copilot 使用统计与额度信息。 |
| `GET /token` | `GET` | 获取当前 API 正在使用的 Copilot token。 |

### Admin / 配置端点

这些端点用于本地管理操作，只接受 `auth.adminApiKey`。

| 端点                                           | 方法   | 说明                                                                                    |
| ---------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| `GET /admin/config/model-mappings`             | `GET`  | 返回当前 `config.json` 路径以及生效中的 `modelMappings` 映射。                          |
| `POST /admin/config/model-mappings`            | `POST` | 只更新 `config.json` 里的 `modelMappings` 字段，并回传更新后的结果。                    |
| `GET /admin/config/responses-websocket`        | `GET`  | 返回有效的 WebSocket 资源上限，以及不含请求内容的 pool/queue 诊断。                     |
| `POST /admin/config/responses-websocket/clear` | `POST` | 仅在显式声明已知 `network_change` 或 `proxy_change` 后关闭池内 WebSocket 连接。          |

## 使用示例

常用 `npx` 命令：

```sh
# 基础启动
npx @encodets/copilot-api@rc start

# 自定义端口并开启详细日志
npx @encodets/copilot-api@rc start --port 8080 --verbose

# 执行认证流程
npx @encodets/copilot-api@rc auth login

# 配置第三方 provider，然后不依赖 GitHub Copilot 启动
npx @encodets/copilot-api@rc auth login --provider dashscope
npx @encodets/copilot-api@rc start

# 以 JSON 格式输出调试信息
npx @encodets/copilot-api@rc debug --json

# 用 Bun 而不是 Node.js 运行已发布 CLI
bunx --bun @encodets/copilot-api@rc start
```

配置 `dashscope` 后的 OpenAI 兼容 provider 调用示例：

```sh
curl http://localhost:4141/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"dashscope/qwen3.6-plus","messages":[{"role":"user","content":"hello"}]}'

curl http://localhost:4141/dashscope/v1/messages \
  -H "content-type: application/json" \
  -d '{"model":"qwen3.6-plus","max_tokens":1024,"messages":[{"role":"user","content":"hello"}]}'

# 已配置名为 "openai" 的 openai-responses provider 时
curl http://localhost:4141/openai/v1/responses \
  -H "content-type: application/json" \
  -d '{"model":"gpt-model-id","input":"hello"}'
```

## 使用建议

<a id="claudemd-or-agentsmd-recommended-content"></a>

### CLAUDE.md 或 AGENTS.md 推荐内容

如果你想手动加入这些提醒，请在 Claude Code 的 `CLAUDE.md`，或 opencode/codex 的 `AGENTS.md` 中加入以下内容：

```
- Prohibited from directly asking questions to users, MUST use question tool.
- Once you can confirm that the task is complete, MUST use question tool to make user confirm. The user may respond with feedback if they are not satisfied with the result, which you can use to make improvements and try again, after try again, MUST use question tool to make user confirm again.
```
