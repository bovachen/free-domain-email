<div align="center">
  <h1>Agentic Inbox</h1>
  <p><em>多域名、任意前缀收信，在 Telegram 里直接处理邮件的自托管邮箱，运行在 Cloudflare Workers 上</em></p>
</div>

一个部署就能同时接收多个域名、任意前缀的邮件。新邮件实时推送到 Telegram，回复、标为已读、加星标、删除、拉黑等常用操作直接在 Telegram 里完成，不用每次都登录网页后台。所有邮件都存放在你自己的 Cloudflare 账户里。

> 本项目 fork 自 [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox)，在上游基础上增加了下面这些功能，并把界面改成了中文。

## 亮点

- **多域名**：一个部署同时接收多个域名的邮件，在 `DOMAINS` 里用英文逗号分隔即可。侧栏按域名分组显示账户，「所有收件箱」合并显示全部邮件
- **泛域名邮箱（任意前缀）**：发往「任意前缀@你的域名」的邮件都能收到，第一封邮件到达时自动创建对应邮箱，不用提前一个个建。每个域名可以在侧栏的 **通配地址** 中单独开关
- **Telegram 新邮件通知**：新邮件实时推送到 Telegram，显示收件邮箱、发件人、主题和正文预览
- **在 Telegram 里直接处理邮件**：通知下方的按钮可以直接标为已读/未读、加星标、删除、标为垃圾邮件、拉黑发件人，每个操作都能撤销；直接回复通知消息，就会以对应邮箱发出邮件回复。常用操作不用再登录网页后台（配置方法见[配置 Telegram 通知](#配置-telegram-通知)）

<p align="center">
  <img src="docs/telegram-alert.png" width="410" alt="Telegram 新邮件通知：显示收件邮箱、发件人、主题和正文预览，下方是打开 Inbox 回复、标为已读、加星标、标为垃圾邮件、删除、拉黑发件人按钮">
</p>

## 其他功能

- **垃圾邮件与黑名单**：可以在邮件列表、阅读界面、AI 助手或 MCP（`report_spam`）中举报垃圾邮件。这封邮件和该发件人的其他邮件会移到垃圾邮件，之后该发件人的邮件直接进入垃圾邮件，不会触发自动起草和通知。在侧栏的 **黑名单** 中管理已拉黑的发件人
- **中文界面**：界面、Telegram 通知、日期格式和邮件引用抬头都使用中文
- **完整的邮件客户端**：通过 Cloudflare Email Routing 收发邮件，支持富文本编辑、按会话归并的回复与转发、文件夹、搜索和附件；有多个邮箱时，写邮件界面可以选择 **发件人**
- **邮箱隔离**：每个邮箱运行在独立的 [Durable Object](https://developers.cloudflare.com/durable-objects/) 中，数据存于 SQLite，附件存于 [R2](https://developers.cloudflare.com/r2/)
- **内置 AI 助手**：基于 [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) 和 [Workers AI](https://developers.cloudflare.com/workers-ai/)，侧边面板提供 10 个邮件工具，可以阅读、搜索、起草、发送邮件以及举报垃圾邮件
- **新邮件自动起草**：助手会自动阅读收到的邮件并生成回复草稿，发送前始终需要你明确确认
- **可配置、可持久化**：每个邮箱可自定义系统提示词，对话历史持久保存，支持流式 Markdown 回复，工具调用过程可见

![Agentic Inbox 网页界面截图](./demo_app.png)

*网页界面截图为上游英文版。想进一步了解 Cloudflare Email Service，以及如何配合 Agents SDK、MCP 和 Wrangler CLI 使用，可以看这篇博客：[Email for Agents](https://blog.cloudflare.com/email-for-agents/)。*

## 如何部署

**重要**：点击「Deploy to Cloudflare」按钮只是部署的一部分，之后还必须完成下面的配置步骤。带截图的完整分步教程见上游的这条评论（英文）：
https://github.com/cloudflare/agentic-inbox/issues/4#issuecomment-4269118513

### 部署步骤

1. 部署到 Cloudflare。部署流程会自动创建 R2、Durable Objects 和 Workers AI，并提示你填写 **DOMAINS**，也就是用来收信的域名（yourdomain.com，对应 email@yourdomain.com）。多个域名用英文逗号分隔。

     [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bovachen/agentic-inbox)

2. **配置 Cloudflare Access**：在 Worker 的 Settings > Domains & Routes 中开启[一键 Cloudflare Access](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/)。弹窗里会显示 `POLICY_AUD` 和 `TEAM_DOMAIN` 的值。`TEAM_DOMAIN` 可以是 Access 团队地址，也可以是完整的 `.../cdn-cgi/access/certs` 地址。**这两个值必须设置为 Worker 的 secret。**
3. **设置 Email Routing**：在 Cloudflare 控制台进入你的域名 > Email Routing，创建一条转发到这个 Worker 的 catch-all 规则。
4. **启用 Email Service**：Worker 需要 `send_email` 绑定才能对外发信，参见 [Email Service 文档](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/)。
5. **创建邮箱**：打开部署好的应用，为你域名下的任意地址创建邮箱（例如 `hello@example.com`）。

### Access 故障排查

1. 如果看到 `Access 令牌无效或已过期`，通常是 `POLICY_AUD` 或 `TEAM_DOMAIN` 这两个 secret 填错了。
   * 解决办法：[把这个 Worker 的 Access 关掉再重新打开](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/)，重新调出 Access 弹窗，然后用弹窗里最新的 `POLICY_AUD` 和 `TEAM_DOMAIN` 重新设置 Worker secret。
2. 如果看到 `生产环境必须配置 Cloudflare Access`，说明应用正在强制要求 Cloudflare Access。这是有意为之，避免你的收件箱暴露给互联网上的任何人。
   * 解决办法：用[一键 Cloudflare Access for Workers](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/) 开启 Access，然后按弹窗里的值设置 `POLICY_AUD` 和 `TEAM_DOMAIN` 这两个 Worker secret。

## 配置 Telegram 通知

新邮件可以推送到 Telegram 对话，并附带操作按钮。在侧栏的 **Telegram 通知** 中配置：

1. 通过 @BotFather 创建机器人并粘贴 Token，然后打开机器人发送 `/start`，Chat ID 会自动绑定。通知里的链接默认指向你打开收件箱时所用的地址；如需改用其他地址，修改面板里的 **收件箱 URL** 即可。
2. 这样就好了。默认由 cron 触发器（`wrangler.jsonc` 中的 `* * * * *`）在 Worker 内部长轮询 Telegram 的 `getUpdates`，所以按钮和回复不需要任何入站路由，也不用改 Access 配置。点击按钮后通常几秒内生效，最慢约一分钟。

可选的即时模式：点击 **连接 Webhook**，把 `https://<你的收件箱地址>/api/telegram/webhook` 注册到 Telegram，并在 Cloudflare Zero Trust 中为这个路径单独添加一个 Access 应用，策略设为对 *Everyone* **Bypass**。Telegram 的服务器无法登录，所以 Worker 用 Telegram 回传的 secret token（`X-Telegram-Bot-Api-Secret-Token`）验证这个路径。注册 Webhook 后轮询会自动暂停。

每条通知都带有可以直接操作的按钮：标为已读/未读、加星标、删除（移到废纸篓）、标为垃圾邮件、拉黑发件人，每个操作都可以撤销。直接回复通知消息，就会从对应邮箱发出邮件回复；`/block <地址>` 和 `/unblock <地址>` 用来管理黑名单。如果 Webhook 和轮询都没开，通知只带一个打开网页界面的链接。

## 技术栈

- **前端：** React 19、React Router v7、Tailwind CSS、Zustand、TipTap、`@cloudflare/kumo`
- **后端：** Hono、Cloudflare Workers、Durable Objects（SQLite）、R2、Email Routing
- **AI 助手：** Cloudflare Agents SDK（`AIChatAgent`）、AI SDK v6、Workers AI（`@cf/moonshotai/kimi-k2.5`）、`react-markdown` + `remark-gfm`
- **鉴权：** Cloudflare Access JWT 校验（本地开发以外的环境必须开启）

## 本地开发

```bash
npm install
npm run dev
```

### 配置

1. 在 `wrangler.jsonc` 中设置你的域名
2. 创建名为 `agentic-inbox` 的 R2 存储桶：`wrangler r2 bucket create agentic-inbox`

如果不想把 `account_id`、自定义域名 `routes` 和真实的 `DOMAINS` 这类部署相关的值提交到 git，可以把 `wrangler.jsonc` 复制为 `wrangler.local.jsonc` 再修改副本。这个文件已加入 .gitignore，只要它存在，`npm run dev` 和 `npm run deploy` 就会用它代替 `wrangler.jsonc`。

### 命令行部署

```bash
npm run deploy
```

## 前置条件

- 拥有域名的 Cloudflare 账户
- 已开启 [Email Routing](https://developers.cloudflare.com/email-routing/)（用于收信）
- 已开启 [Email Service](https://developers.cloudflare.com/email-service/)（用于发信）
- 已开启 [Workers AI](https://developers.cloudflare.com/workers-ai/)（AI 助手需要）
- 部署或共享的环境已配置 [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)（生产环境必需）

按照设计，任何通过了共享 Cloudflare Access 策略的用户都能访问本应用中的所有邮箱，包括位于 `/mcp` 的 MCP 服务器：通过 MCP 连接的外部 AI 工具（Claude Code、Cursor 等）只要传入 `mailboxId` 参数，就能操作任意邮箱。应用没有按邮箱划分的权限控制，Cloudflare Access 策略是唯一的信任边界。

## 架构

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Browser    │────>│  Hono Worker     │────>│  MailboxDO      │
│  React SPA   │     │  (API + SSR)     │     │  (SQLite + R2)  │
│  Agent Panel │     │                  │     └─────────────────┘
└──────┬───────┘     │  /agents/* ──────┼────>┌─────────────────┐
       │             │                  │     │  EmailAgent DO  │
       │ WebSocket   │                  │     │  (AIChatAgent)  │
       └─────────────┤                  │     │ 10 email tools  │
                     │                  │────>│  Workers AI     │
                     └──────────────────┘     └─────────────────┘
```

## 许可证

Apache 2.0，详见 [LICENSE](LICENSE)。
