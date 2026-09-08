# Copilot 原生 Responses 转发验证（2026-09-08）

验证时间：2026-09-08。基线：`v2.0.0-rc.27` / `59521de0`。

使用 GitHub Copilot 凭据签发的 `https://api.enterprise.githubcopilot.com`，模型为 `gpt-6-astra`。共执行 22 次合成 Responses HTTP 请求、1 次 WebSocket 错误探测；模型目录读取及令牌交换不计入这个数量。没有请求 OpenAI 的模型服务，没有回放用户的真实会话，没有安装或重启当前桌面服务。凭据仅在进程内使用；保存的报告不包含令牌、完整 item ID 或加密历史正文。

## 上游结果与处理决定

| 检查 | 实际结果 | 决定 |
| --- | --- | --- |
| 省略 `service_tier` | HTTP 200，响应报告 `default` | 保留现状 |
| `auto`、`default`、`priority`、`fast`、无效 tier | 均为 HTTP 400，`unsupported_value`，`service_tier is not supported` | 不改为原样透传；继续兼容剥离，不声称支持 Fast |
| 流式 message、reasoning、function_call 的 item ID | `added`、`done`、`completed.output` 中不同 | 差异确实来自上游；不移除既有 SDK 兼容逻辑 |
| 加密 reasoning + function call 的三种 ID 回放 | 分别回放 `completed`、`done`、`added` ID，全部 HTTP 200/completed，返回正确的历史标记和工具结果标记 | 未证明现有 ID 修复会导致解密失败，撤回将它直接列为 P1 的判断 |
| WebSocket 不存在的模型 | 上游返回 `{type: "error", error: {...}}`，没有 `sequence_number` | 修复终止判断；缺失序号仅在内部解析视图使用默认值，保留原始 wire 数据 |
| PNG / JPEG，`detail: original` | 两次均 HTTP 400，图片验证器拒绝 | Copilot 路由映射为 `high`，不改图片字节；Copilot 模型目录不再宣称支持 original |
| `high`、`low`、`auto`、省略 detail | 均 HTTP 200，正确识别合成红色图片；JPEG/high 也成功 | 保留这些已验证取值 |
| 修改后的完整路由接收 original 图片 | 流式、非流式均 HTTP 200/completed，输出 RED，携带上游请求 ID | 验证映射、序列化、上游响应及响应头整个链路 |
| 真实响应头 | 成功和 400 均包含上游请求 ID | 补齐安全元数据转发 |
| 503 的 Retry-After | 本地故障注入；未对真实服务制造 503/429 | 所有 HTTP 错误状态统一保留允许的重试、限流、追踪头 |

## 图片顺序的本地验证

使用三张合成历史图片及隔离的预算，不发送大体积压力请求。

- 处理旧图足以满足限制：只替换两张旧图，最新图片保持不变。
- 处理旧图仍不足，允许最新图兜底：最后才替换最新图。
- 同样条件下禁止最新图兜底：保留最新图，返回不可发送，由调用层报告 413。
- 压缩尝试顺序为旧图 soft、必要时最新图 soft、旧图更强压缩，然后再进入替换/最新图硬限制兜底。这不是严格“完全耗尽旧图所有压缩方案后才碰新图”。

本次保留原有图片优化顺序与配置默认值，仅修复 Copilot 拒绝的 detail 参数。小图颜色识别成功不代表有损压缩后 OCR、细节识别无损；本次未重新验证 32 MiB 极限。

## 本地修改

1. Copilot 请求将 `detail: original` 兼容为 `high`；相应客户端能力声明收窄。独立原生 provider 的目录不在该投影路径中。
2. 接受 Copilot 缺少序号的合法错误包（支持嵌套 error），不再在真实错误后追加 EOF 错误。非错误事件仍遵循既有序号验证。
3. 原生 HTTP 成功响应和 HTTP 错误统一转发允许的元数据：请求追踪、Retry-After、限流信息等；不转发 cookies、认证、传输长度或上游安全策略。

没有实现删除压缩快照、历史重建、重新摘要、服务 tier 透传或 ID 策略变更。本次合成回放也不能证明已有失败会话中的快照有效，或保证旧会话恢复。

## 回归与证据边界

- 12 个相关测试文件：343 passed，0 failed，1417 assertions。
- 修改的可执行源码行覆盖：56/56（100%）。这不是全仓库覆盖率。
- ESLint、TypeScript、CLI build、desktop server build 通过。
- Bun/Windows 下部分 mock + unref timer 测试需使用已有 keepalive preload；未带该辅助的运行停滞后已停止，最终结果来自带辅助的完整运行。
- 隔离路由连接真实 Copilot 的流式和非流式图片请求均通过；生产桌面实例没有切换到这份源码。

## 参考

- [OpenAI streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [OpenAI Fast mode / service_tier](https://developers.openai.com/api/docs/guides/priority-processing)
- [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction)

OpenAI 文档用于核对协议意图；上述兼容决定以本次 Copilot 上游实测为依据，不把 OpenAI 支持直接当作 Copilot 支持。
