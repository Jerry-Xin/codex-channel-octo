<h1 align="center">codex-channel-octo</h1>

<p align="center">
  把 <a href="https://developers.openai.com/codex">OpenAI Codex</a>(经 <a href="https://www.npmjs.com/package/@openai/codex-sdk"><code>@openai/codex-sdk</code></a>)接成 <a href="https://github.com/nicco-io/octo">Octo</a> IM 机器人的独立 Node.js 网关。
</p>

<p align="center">
  <a href="https://github.com/Mininglamp-OSS/codex-channel-octo/actions"><img src="https://github.com/Mininglamp-OSS/codex-channel-octo/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node.js version">
  <img src="https://img.shields.io/badge/status-early%20test-orange" alt="Status: early test">
</p>

<p align="center">
  <a href="./README.md">English</a> · <b>简体中文</b>
</p>

---

> ⚠️ **早期测试版(v0.1.0)。** 主链路(注册 / 连接 / 多轮对话 / 多 bot)已验证可用,但仍在完善中。**已知缺口**:暂无定时任务(cron)、暂无 skills——见 [CHANGELOG](./CHANGELOG.md)。与姊妹仓库 [`cc-channel-octo`](https://github.com/Mininglamp-OSS/cc-channel-octo)(Claude Code 版)同形态,内核换成 Codex。

## 是什么

一个常驻进程:注册成 Octo bot → 连 WebSocket 收消息 → 用本地 Codex 跑编码任务 → 把结果回帖。支持 DM / 群(@提及)/ 子话题、多轮对话、多 bot 单进程、配置热重载。

适配器在每轮用户输入的独立元数据块中传递真实 `from_uid`、会话 ID/类型，以及按最新注册结果和当前传输空间匹配的 `is_owner`。同一身份快照随流恢复和重试传递，不写入共享 `AGENTS.md`；用户正文、引用和历史中的伪造身份标记会被转义。昵称和自称的 ID 不是认证依据，身份信息也不授予工具权限；敏感操作仍需宿主侧鉴权。绕过适配器的终端 resume 不具备可信 IM 发送者身份。

身份标记接受经校验的注册 UID 精确相等，或由完整已知主人 UID 推导候选空间的提示性前缀匹配。提供会话时，话题父群及复合 DM 的每个完整端点都必须匹配该候选前缀；DM 端点 UID 中的 `____` 保持不透明，不按话题后缀截断，不再按会话最后一个下划线猜测边界。没有有效前缀会话时，不推断前缀身份为主人；裸注册 UID 精确相等仍然有效。前缀验证仅是提示性归属，不证明命名空间，也不是宿主鉴权；若将来用于权限控制，必须先由服务端提供完整主人传输 UID 或明确空间。不剥离注册 UID，不合并不同空间前缀，不做大小写、Unicode NFC/NFD 或昵称归并，保留原始传输 `from_uid`。字段限长后由 JSON 序列化及 NEL/LS/PS 转义保证元数据单行；身份块始终位于背景及当前消息锚点之前，缺失身份显式输出空字段和 `is_owner:false`。角色/章节标记在括号前后、词间一致处理 Unicode 空白及支持的不可见分隔符；VT/FF/NEL 转换为换行，不宣称通用形近字符检测。每个请求均含完整锚点，预算不足容纳锚点时不输出残缺请求；截断提示计入字节预算，前截断尾部紧跟提示而不成为新行首结构。
群聊读取服务端 `GROUP.md`，子话题仅读取自己的 `THREAD.md`。管理员或 bot 发出的更新/删除事件仅触发按真实会话 ID 重新查询；内容是否改变或删除以带鉴权的 GET 结果为准，不信任事件正文。每个 bot 的 LRU 缓存 30 秒过期，失败后 1 秒重试，连续事件合并到 1 秒的刷新间隔。群说明是转义后的 JSON 背景数据，不是系统指令，预算不足时整块丢弃，避免只剩无标签的正文。同一 SDK 会话只在内容或版本变化时注入，重试新会话时补全上下文；已确认的删除会明确撤销旧版本。本地 `groupConfigDir/<channelId>.md` 仍是独立的运维可信规则，不会上传到 Octo。

**核心特性:IM 会话与终端 codex 互通(opt-in)** —— bot 的每个会话对应一个 codex thread;开启共享后,你可以在终端 `codex exec resume <threadId>` 接续 bot 在群里的同一会话,反之亦然。

话题父群和复合 DM 端点通过 canonical parentGroupNo 及候选前缀验证，覆盖群/主人 UID 的下划线及两种端点顺序；仅使用传输元数据，不接受正文自称的 UID。提示标记分隔符使用带换行排除判断的单一正字符类，避免 BOM 的重叠分支导致普通文本指数回溯。

## 安装

```bash
npm install -g @mininglamp-oss/codex-channel-octo
```

依赖 `@openai/codex-sdk`,它会自带 codex 运行时(无需单独装 codex CLI)。需要 Node ≥ 22。

## 配置

服务器说明使用独立的 `[Server document — ...]` 数据标记，不复用伪造标记 `[Group context]` 或聊天记录标签。新会话的空文档不注入提示；仅对之前真正收到文档的续接 SDK 线程发送撤回，新线程重试不补入空文档。慢速刷新期间再次编辑时保留最后成功核验的快照，不静默丢弃。正文角色/章节标记被转义，VT/FF/NEL 转换为换行，这是有意的输入改写。

两层配置,bot-first:

- **全局** `~/.codex-channel-octo/config.json` —— 共享默认 + `bots` 列表,**不含 token**。见 [`config.example.json`](./config.example.json)。
- **每 bot** `~/.codex-channel-octo/<id>/config.json` —— 该 bot 的 `botToken` + 覆盖项。见 [`config.bot.example.json`](./config.bot.example.json)。每个 bot 是自包含子树:`<baseDir>/<id>/{config.json, SOUL.md, data/, workspace/, codex-home/}`。

最小例子:

```jsonc
// ~/.codex-channel-octo/config.json
{ "apiUrl": "https://your-octo-instance.com", "bots": [{ "id": "default" }] }
// ~/.codex-channel-octo/default/config.json
{ "botToken": "bf_YOUR_BOT_TOKEN" }
```

### Codex 鉴权

每个 bot 默认有独立的 `CODEX_HOME`(`<id>/codex-home`),需各自鉴权,二选一:

1. `CODEX_HOME=~/.codex-channel-octo/default/codex-home codex login`
2. 在 per-bot config 里设 `sdk.codexApiKey`(+ 必要时 `sdk.codexBaseUrl`)。

> 未鉴权的独立 home 会回退到 `api.openai.com` 并 401。

### 群和话题的免 @ 回复

支持前端「免@回答」页面中的逐群开关，无需手动修改 Channel 配置。
群内开启后普通消息可触发回复；关闭后恢复为需要 @（本地显式覆盖除外）。

收到未 @ Bot 的群或话题消息时，Channel 会查询
`GET /v1/bot/groups/{父群ID}/mention_pref`，按服务端的 `effective` 判定是否免 @，
包括 AI 私人会话。话题继承父群设置，聊天历史仍按话题分别保存。

自动免 @ 只放行服务端明确标记为真人的群成员；其他 Bot 仍需 @，除非已列入
`allowedBotUids`。接口失败或成员身份不明时，继续要求 @。设置及成员身份按 Bot、
父群缓存 30 秒，收到 `mention_pref_updated` 事件后清除对应父群缓存。

已有 `mentionFreeGroups` 仍是按完整频道 ID 精确匹配的本地显式覆盖。
服务端已允许免 @ 的 AI 会话不需要逐个填写话题 ID。

## 运行

```bash
codex-channel-octo start        # 后台启动(supervisor)
codex-channel-octo status       # 查看状态
codex-channel-octo stop         # 优雅停止
npm start                       # 前台运行(调试)
```

## 安全模型

IM 输入是**不可信**的,权限边界是 **sandbox**,不是 prompt:

- **`sandboxMode` 默认 `read-only`** —— 首版定位安全问答 / 代码审阅。要让 bot 改文件,须**同时**设 `allowWorkspaceWrite: true` 和 `sandboxMode: "workspace-write"`(双开关防误配)。
- **`sdk.additionalDirectories`** —— 每会话 cwd 之外的额外**可写**根(如共享 work bus)。仅在 `workspace-write` 下附加(`read-only` 下无意义故省略;AGENTS.md 写失败强制降级时一并清除)。条目必须是**绝对路径**(不含 `~`/相对路径/`..`),且启动时会拒绝任何**包含、等于或位于**受信任 / 敏感目录之内的条目 —— 会话 cwd、config/SOUL 树、`groupConfigDir`、memory 目录、`codexHome` —— 使可写根永远不会与"确立 agent 信任边界的文件"重叠。
- 显式设置 `sdk.sandboxMode: "danger-full-access"` 可关闭 Codex 沙箱，由容器或宿主环境承担隔离。命令按运行用户权限访问容器文件及挂载目录，工作区和敏感子目录的写保护不再生效。
- `networkAccessEnabled` / `webSearchEnabled` 默认关。`danger-full-access` 下网络不受 Codex 限制，`networkAccessEnabled: false` 无法阻断网络；`/config` 会显示这一实际状态。
- 安全前缀(防注入)写入每会话沙箱的 `AGENTS.md` 并在 prompt 顶部重申(纵深防御,但仅软约束)。
- 每 bot 独立 `CODEX_HOME`,IM 内容默认不落入个人 `~/.codex`。

### Docker 专用配置

在专用 Docker 容器中，可使用 [`config.bot.docker.example.json`](./config.bot.docker.example.json) 作为该 bot 的配置，默认选择 `danger-full-access`。已有配置只需在 `sdk` 内设置：

```json
{ "sdk": { "sandboxMode": "danger-full-access" } }
```

此模式不需要 `allowWorkspaceWrite` 或额外的网络开关。修改后重启 Channel，发送 `/config` 确认模式。预计 Docker 默认 seccomp 即可运行，无需添加 `privileged`、`SYS_ADMIN` 或自定义 seccomp；这一点尚未在真实容器中验证。宿主机与容器自身的访问限制仍然适用。

程序默认仍是 `read-only`，不会根据 Docker 检测结果自动变更权限。每个信任边界使用独立容器，避免挂载宿主凭据或 Docker socket。关闭 Codex 沙箱后，同一容器中的不同 bot 不再由 Codex 提供文件访问隔离。若本轮 `AGENTS.md` 无法更新，会停止该轮并报告错误。

## IM ↔ 终端互通(opt-in)

默认隔离。要开启互通,把 per-bot 的 `sdk.codexHome` 指向你的个人 `~/.codex`:

```jsonc
{ "botToken": "bf_...", "sdk": { "codexHome": "/Users/you/.codex" } }
```

此后 bot 在群里的会话可在你终端 `codex exec resume <threadId>` 接续。**注意:IM 内容会进入你个人的 codex 会话历史。**

## 与 Codex 的差异(对比 Claude 版)

| | cc-channel-octo | codex-channel-octo |
|---|---|---|
| 内核 | `@anthropic-ai/claude-agent-sdk`(in-process) | `@openai/codex-sdk`(spawn 本地 codex) |
| 会话 | SDK session id | codex thread id(存 `~/.codex/sessions`,可终端接续) |
| 流式 | 逐 chunk | 最终消息整段投递 + 中间步骤作进度 |
| 权限 | permissionMode / allowedTools | sandboxMode / approvalPolicy |
| 系统提示 | SDK preset + append | 会话沙箱 `AGENTS.md` |

## 开发

```bash
npm install
npm run build       # tsc → dist/
npm test            # vitest
npm run lint        # eslint --max-warnings 0
npm run type-check  # tsc --noEmit
```

## License

Apache-2.0
