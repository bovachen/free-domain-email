<div align="center">
  <h1>Agentic Inbox</h1>
  <p><em>A self-hosted email client with an AI agent, running entirely on Cloudflare Workers</em></p>
</div>

Agentic Inbox lets you send, receive, and manage emails through a modern web interface -- all powered by your own Cloudflare account. Incoming emails arrive via [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), each mailbox is isolated in its own [Durable Object](https://developers.cloudflare.com/durable-objects/) with a SQLite database, and attachments are stored in [R2](https://developers.cloudflare.com/r2/).

An **AI-powered Email Agent** can read your inbox, search conversations, and draft replies -- built with the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) and [Workers AI](https://developers.cloudflare.com/workers-ai/).

> **About this fork:** this is a fork of [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox). It adds a unified inbox across mailboxes, multiple domains with catch-all addresses, a Spam folder with a sender blacklist, and Telegram alerts you can act on without opening the app. See [Added in this fork](#added-in-this-fork).

![Agentic Inbox screenshot](./demo_app.png)


Read the blog post to learn more about Cloudflare Email Service and how to use it with the Agents SDK, MCP, and from the Wrangler CLI: [Email for Agents](https://blog.cloudflare.com/email-for-agents/).

## How to setup

**Important**: Clicking the 'Deploy to Cloudflare' button is only one part of the setup. You must follow the **After deploying** steps as well. For a full step-by-step guide with screenshots, refer to this comment: 
https://github.com/cloudflare/agentic-inbox/issues/4#issuecomment-4269118513

### To set up

1. Deploy to Cloudflare. The deploy flow will automatically provision R2, Durable Objects, and Workers AI. You'll be prompted for **DOMAINS**, which is the domain (yourdomain.com) you want to receive emails for (email@yourdomain.com). Separate several domains with commas.

     [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bovachen/agentic-inbox)

2. **Configure Cloudflare Access** -- Enable [one-click Cloudflare Access](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/) on your Worker under Settings > Domains & Routes. The modal will show your `POLICY_AUD` and `TEAM_DOMAIN` values. `TEAM_DOMAIN` can be either your Access team URL or the full `.../cdn-cgi/access/certs` URL. **You must set these as secrets for your Worker.**
3. **Set up Email Routing** -- In the Cloudflare dashboard, go to your domain > Email Routing and create a catch-all rule that forwards to this Worker
4. **Enable Email Service** -- The worker needs the `send_email` binding to send outbound emails. See [Email Service docs](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/)
5. **Create a mailbox** -- Visit your deployed app and create a mailbox for any address on your domain (e.g. `hello@example.com`)

### Troubleshooting Access

1. If you see `Invalid or expired Access token`, that usually means `POLICY_AUD` or `TEAM_DOMAIN` secrets are incorrect.
   * Resolution: [turn Access off and back on for the Worker to get the Access modal again](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/), then reset your Worker secrets to the latest `POLICY_AUD` and `TEAM_DOMAIN` values shown there.
2. If you see `Cloudflare Access must be configured in production`, this application is intentionally enforcing Cloudflare Access so your inbox is not exposed to anyone on the internet.
   * Resolution: enable Access using [one-click Cloudflare Access for Workers](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/), then set the `POLICY_AUD` and `TEAM_DOMAIN` Worker secrets from the modal values.

### Telegram alerts (optional)

New mail can be pushed to a Telegram chat with inline buttons. Configure it from the sidebar (**Telegram alerts**):

1. Create a bot with @BotFather and paste the token; open the bot and send `/start` — the chat ID binds automatically. Links in alerts point back to the address you opened the inbox from; set **Inbox URL** to use a different one.
2. That's it. By default a cron trigger (`* * * * *` in `wrangler.jsonc`) long-polls Telegram's `getUpdates` from inside the Worker, so button taps and replies need no inbound route and no Access changes. A tap usually lands within a few seconds, worst case about a minute.

Optional instant delivery: click **Connect webhook** to register `https://<your-inbox>/api/telegram/webhook` with Telegram, and in Cloudflare Zero Trust add a second Access application for that path with a **Bypass** policy for *Everyone*. Telegram's servers cannot log in, so the Worker authenticates that path with the secret token Telegram echoes back (`X-Telegram-Bot-Api-Secret-Token`). Polling pauses automatically while a webhook is registered.

Each alert offers buttons that act in place — mark read/unread, star, delete (to Trash), mark as spam, block the sender — each with its undo; replying to the alert message sends an email reply from that mailbox, and `/block <address>` / `/unblock <address>` manage the blacklist. Without the webhook, the alert falls back to a link that opens the web UI.

## Features

- **Full email client** — Send and receive emails via Cloudflare Email Routing with a rich text composer, reply/forward threading, folder organization, search, and attachments
- **Per-mailbox isolation** — Each mailbox runs in its own Durable Object with SQLite storage and R2 for attachments
- **Built-in AI agent** — Side panel with 10 email tools for reading, searching, drafting, sending, and reporting spam
- **Auto-draft on new email** — Agent automatically reads inbound emails and generates draft replies, always requiring explicit confirmation before sending
- **Configurable and persistent** — Custom system prompts per mailbox, persistent chat history, streaming markdown responses, and tool call visibility

### Added in this fork

- **Unified inbox** — "All Inboxes" and the other system folders merge every mailbox. The sidebar groups accounts by domain, and the composer shows a **From** picker when you have more than one mailbox
- **Multiple domains and catch-all addresses** — `DOMAINS` takes a comma-separated list. Catch-all is on per domain by default: mail to any address at that domain creates its mailbox automatically. Turn it off per domain under **Catch-all addresses** in the sidebar
- **Spam folder and sender blacklist** — Report spam from the email list, the reader, the agent, or MCP (`report_spam`). The email and the sender's other mail move to Spam, and later mail from that sender goes straight to Spam without triggering auto-drafts or alerts. Manage blocked senders under **Blacklist** in the sidebar
- **Telegram alerts** — New mail is pushed to Telegram with buttons to mark read, star, delete, flag spam, or block the sender, and replying to an alert sends an email reply. See [Telegram alerts](#telegram-alerts-optional)

## Stack

- **Frontend:** React 19, React Router v7, Tailwind CSS, Zustand, TipTap, `@cloudflare/kumo`
- **Backend:** Hono, Cloudflare Workers, Durable Objects (SQLite), R2, Email Routing
- **AI Agent:** Cloudflare Agents SDK (`AIChatAgent`), AI SDK v6, Workers AI (`@cf/moonshotai/kimi-k2.5`), `react-markdown` + `remark-gfm`
- **Auth:** Cloudflare Access JWT validation (required outside local development)

## Getting Started

```bash
npm install
npm run dev
```

### Configuration

1. Set your domain in `wrangler.jsonc`
2. Create an R2 bucket named `agentic-inbox`: `wrangler r2 bucket create agentic-inbox`

To keep deployment-specific values such as `account_id`, custom domain `routes`, and your real `DOMAINS` out of git, copy `wrangler.jsonc` to `wrangler.local.jsonc` and edit the copy. It is gitignored, and `npm run dev` / `npm run deploy` use it in place of `wrangler.jsonc` whenever it exists.

### Deploy

```bash
npm run deploy
```

## Prerequisites

- Cloudflare account with a domain
- [Email Routing](https://developers.cloudflare.com/email-routing/) enabled for receiving
- [Email Service](https://developers.cloudflare.com/email-service/) enabled for sending
- [Workers AI](https://developers.cloudflare.com/workers-ai/) enabled (for the agent)
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) configured for deployed/shared environments (required in production)

Any user who passes the shared Cloudflare Access policy can access all mailboxes in this app by design. This includes the MCP server at `/mcp` -- external AI tools (Claude Code, Cursor, etc.) connected via MCP can operate on any mailbox by passing a `mailboxId` parameter. There is no per-mailbox authorization; the Cloudflare Access policy is the single trust boundary.

## Architecture

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

## License

Apache 2.0 -- see [LICENSE](LICENSE).
