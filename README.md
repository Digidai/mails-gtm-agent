# mails-gtm-agent

Open-source AI SDR (Sales Development Representative) Agent. Runs on Cloudflare Workers, uses AI to generate personalized cold outreach emails, classify replies, and manage multi-step campaigns automatically.

Built on top of [mails-agent](https://github.com/Digidai/mails) for email delivery.

## Features

- **AI-Powered Email Generation** -- Uses Claude via OpenRouter to craft personalized cold emails based on recipient context
- **Intelligent Reply Classification** -- Automatically classifies reply intent (interested, not now, unsubscribe, etc.) and takes appropriate action
- **Multi-Step Campaigns** -- Define sequences with configurable delays between steps
- **Warmup Scheduling** -- Gradually ramp up sending volume to protect sender reputation
- **CAN-SPAM / GDPR Compliance** -- Automatic List-Unsubscribe headers, physical address footer, one-click unsubscribe, and GDPR data deletion
- **CSV Import** -- Bulk import contacts with custom fields
- **Self-Learning Agent** -- Learns from reply patterns, adapts messaging strategy over time
- **Daily Summary** -- Automated digest of campaign performance, replies, and actions taken
- **MCP Server** -- Manage campaigns directly from Claude Code, Cursor, or Windsurf
- **Reviewer Agent (Fail-Safe)** -- AI pre-review defaults to safe template when LLM is unavailable
- **Event-Driven Reply Processing** -- Real-time inbound email processing via webhook (with 5-minute cron fallback)
- **Contact State Machine** -- Priority-based status transitions prevent race conditions across concurrent writers
- **Bounce Handling** -- Webhook endpoint for email provider bounce notifications, with global suppression
- **Outbound Webhooks** -- Send campaign events (interested reply, conversion, bounce) to external URLs for CRM/Slack integration
- **Thread-Based Reply Matching** -- Uses In-Reply-To headers for accurate multi-campaign reply routing
- **Serverless** -- Zero infrastructure to manage, runs entirely on Cloudflare Workers + D1 + Queues

## Architecture

```
Cron (1min) ──> send-cron ──> Queue ──> send-consumer ──> mails-agent API
Cron (5min) ──> reply-cron (fallback) ──> classify ──> update status
Cron (10min)──> agent-cron ──> Queue ──> evaluate-consumer ──> LLM decide
Cron (daily)──> summary-cron ──> daily digest

Webhook ────> /webhook/inbound ──> classify ──> auto-reply (real-time)
Webhook ────> /webhook/bounce  ──> state machine ──> global suppression
Webhook ────> /webhook/event   ──> conversion tracking
```

| Component | Technology |
|-----------|-----------|
| Runtime | Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Queue | Cloudflare Queues |
| LLM | OpenRouter (Claude Sonnet) |
| Email | mails-agent API |

### LLM Provider

All LLM calls go through a unified provider interface (`src/llm/provider.ts`). By default, it uses OpenRouter with automatic 429 retry (2 attempts, exponential backoff).

| Setting | Default | Description |
|---------|---------|-------------|
| `OPENROUTER_API_KEY` | Required | OpenRouter API key |
| `LLM_MODEL` | `anthropic/claude-sonnet-4` | Model to use via OpenRouter |

To use a different LLM provider, modify `src/llm/provider.ts`.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) (runtime + test runner)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (Cloudflare CLI)
- A Cloudflare account with Workers, D1, and Queues enabled
- An [OpenRouter](https://openrouter.ai) API key
- A [mails-agent](https://github.com/Digidai/mails) instance

### Installation

```bash
git clone https://github.com/Digidai/mails-gtm-agent.git
cd mails-gtm-agent
bun install
```

### Configuration

1. Create D1 database and Queue:

```bash
wrangler d1 create mails-gtm
wrangler queues create mails-gtm-send
```

2. Update `wrangler.toml` with your D1 database ID.

3. Initialize the database schema:

```bash
bun run db:init
```

4. Set secrets:

```bash
wrangler secret put OPENROUTER_API_KEY
wrangler secret put MAILS_API_KEY
wrangler secret put ADMIN_TOKEN
wrangler secret put MAILS_MAILBOX
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENROUTER_API_KEY` | Yes | -- | OpenRouter API key for LLM calls |
| `MAILS_API_KEY` | Yes | -- | mails-agent API authentication token |
| `MAILS_MAILBOX` | Yes | -- | Sender email address (e.g. `hi@genedai.space`) |
| `ADMIN_TOKEN` | Yes | -- | Bearer token for authenticating API requests |
| `MAILS_API_URL` | No | `https://mails-worker.genedai.workers.dev` | mails-agent base URL |
| `UNSUBSCRIBE_BASE_URL` | No | Worker origin | Base URL for unsubscribe links |
| `DAILY_SEND_LIMIT` | No | `100` | Global daily send cap across all campaigns |
| `WEBHOOK_SECRET` | No | -- | HMAC-SHA256 secret for inbound webhook signature verification (must match mails-agent) |

### Development

```bash
bun run dev    # Start local dev server
bun test       # Run tests
```

### Deploy

```bash
bun run deploy
```

## API Reference

All `/api/*` endpoints require `Authorization: Bearer {ADMIN_TOKEN}`.

### Campaigns

#### Create Campaign

```bash
curl -X POST https://your-worker.workers.dev/api/campaign/create \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Q1 Outreach",
    "product_name": "SuperSaaS",
    "product_description": "AI-powered analytics for growing teams",
    "from_email": "hi@genedai.space",
    "physical_address": "123 Main St, San Francisco, CA 94105",
    "ai_generate": true,
    "warmup_enabled": true,
    "steps": [
      { "delay_days": 0, "subject_template": "", "body_template": "" },
      { "delay_days": 3, "subject_template": "Following up", "body_template": "Hi {{name}}, just checking in..." },
      { "delay_days": 5, "subject_template": "Quick question", "body_template": "Hi {{name}}, one last note..." }
    ]
  }'
```

#### List Campaigns

```bash
curl https://your-worker.workers.dev/api/campaign/list \
  -H "Authorization: Bearer $TOKEN"
```

#### Get Campaign Details

```bash
curl https://your-worker.workers.dev/api/campaign/{id} \
  -H "Authorization: Bearer $TOKEN"
```

#### Start / Pause Campaign

```bash
curl -X POST https://your-worker.workers.dev/api/campaign/{id}/start \
  -H "Authorization: Bearer $TOKEN"

curl -X POST https://your-worker.workers.dev/api/campaign/{id}/pause \
  -H "Authorization: Bearer $TOKEN"
```

### Contacts

#### Import Contacts (CSV)

```bash
curl -X POST https://your-worker.workers.dev/api/contacts/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "campaign_id": "abc123",
    "csv": "email,name,company,role\nalice@acme.com,Alice,Acme Inc,CTO\nbob@beta.io,Bob,Beta Corp,VP Eng"
  }'
```

Or via multipart form:

```bash
curl -X POST https://your-worker.workers.dev/api/contacts/import \
  -H "Authorization: Bearer $TOKEN" \
  -F "campaign_id=abc123" \
  -F "file=@contacts.csv"
```

### Unsubscribe (Public)

```
GET /unsubscribe?token={token}
```

No authentication required. Renders an HTML confirmation page.

### GDPR

#### Delete User Data

```bash
curl -X POST https://your-worker.workers.dev/api/gdpr/delete \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com"}'
```

## Webhooks

### Inbound Email (from mails-agent)

Configure `webhook_url` in mails-agent's `auth_tokens` table to receive real-time inbound email notifications:

```sql
UPDATE auth_tokens SET webhook_url = 'https://your-gtm-agent.workers.dev/webhook/inbound' WHERE mailbox = 'your@mailbox.com';
```

Requires `WEBHOOK_SECRET` to be set on both mails-agent and mails-gtm-agent for HMAC-SHA256 signature verification.

### Bounce Webhook

```bash
curl -X POST https://your-worker.workers.dev/webhook/bounce \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "bounced@example.com", "type": "bounce", "reason": "Mailbox not found"}'
```

Marks the contact as bounced across all campaigns and adds to global suppression list.

### Outbound Webhook (Campaign Events)

Set `webhook_callback_url` when creating a campaign to receive event notifications:

```json
{
  "webhook_callback_url": "https://your-crm.com/api/webhook"
}
```

Events sent: `interested_reply`, `conversion`, `campaign_error`, `knowledge_gap`, `conversation_stopped`. Payload is HMAC-signed if `webhook_secret` is configured.

## Reply Intent Taxonomy

| Intent | Action |
|--------|--------|
| `interested` | Mark as interested, stop sequence |
| `not_now` | Pause, schedule resume (default 30 days) |
| `not_interested` | Mark as not interested, stop sequence |
| `wrong_person` | Mark, stop sequence |
| `out_of_office` | Keep in sequence, retry later |
| `unsubscribe` | Unsubscribe, add to suppression list |
| `auto_reply` | Ignore, keep in sequence |
| `do_not_contact` | Permanent block, add to suppression list |
| `unclear` | Mark as replied for manual review |

## Contact State Machine

All contact status transitions go through a priority-based state machine that prevents race conditions:

| Priority | Status | Terminal? |
|----------|--------|-----------|
| 0 (highest) | do_not_contact | Yes |
| 1 | unsubscribed | Yes |
| 2 | bounced | Yes |
| 3 | converted | Yes |
| 4 | interested | Yes |
| 5 | stopped | Yes |
| 6 | error | Yes |
| 7 | not_interested | Yes |
| 8 | wrong_person | No |
| 9 | not_now | No |
| 10 | replied | No |
| 11 | active | No |
| 12 | queued | No |
| 13 | sent | No |
| 14 (lowest) | pending | No |

**Rule:** A contact cannot transition from a higher-priority status to a lower-priority status. For example, an `interested` contact cannot be changed back to `active`.

**Exceptions:**
- `not_now` → `pending` (when resume_at expires)
- `wrong_person` → any (reclassification on new reply)

## Competitive Landscape

| Feature | mails-gtm-agent | Instantly | Smartlead | Apollo |
|---------|:---:|:---:|:---:|:---:|
| Open Source | Yes | No | No | No |
| Self-hosted | Yes | No | No | No |
| AI Email Generation | Yes | Yes | Yes | Yes |
| AI Reply Classification | Yes | No | No | Limited |
| Warmup | Yes | Yes | Yes | Yes |
| Multi-step Sequences | Yes | Yes | Yes | Yes |
| CAN-SPAM Compliance | Yes | Yes | Yes | Yes |
| GDPR Data Deletion | Yes | Limited | Limited | Limited |
| Bring Your Own LLM | Yes | No | No | No |
| Price | Free | $30+/mo | $39+/mo | $49+/mo |

## MCP Server

Manage campaigns from any MCP-compatible AI assistant:

```bash
MAILS_GTM_URL=https://your-worker.workers.dev MAILS_GTM_TOKEN=your-token bun mcp/index.ts
```

Claude Desktop config (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "mails-gtm": {
      "command": "bun",
      "args": ["/path/to/mails-gtm-agent/mcp/index.ts"],
      "env": {
        "MAILS_GTM_URL": "https://your-worker.workers.dev",
        "MAILS_GTM_TOKEN": "your-admin-token"
      }
    }
  }
}
```

## CLI

```bash
# Create and run a campaign
mails-gtm campaign create --name "Q1 Outreach" --engine agent
mails-gtm contacts import <campaign-id> --csv contacts.csv
mails-gtm campaign start <campaign-id>

# Monitor
mails-gtm campaign stats <campaign-id>
mails-gtm campaign events <campaign-id>
mails-gtm campaign decisions <campaign-id>
```

## License

MIT
