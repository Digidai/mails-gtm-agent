# Quickstart — 5 minutes from clone to first email

This walks you through running `mails-gtm-agent` against a real mailbox
and sending one AI-generated cold email to **yourself** as the recipient.
After that you can swap in a real CSV and a real product URL.

> All commands assume your shell is at the repo root (`mails-gtm-agent/`).

---

## Prerequisites (1 min)

| Need | Get it from |
|------|-------------|
| Cloudflare account (Workers, D1, Queues enabled) | [dash.cloudflare.com](https://dash.cloudflare.com) — Workers Free is enough |
| Wrangler CLI authenticated | `wrangler login` |
| Bun ≥ 1.0 | [bun.sh](https://bun.sh) — `curl -fsSL https://bun.sh/install \| bash` |
| OpenRouter API key | [openrouter.ai/keys](https://openrouter.ai/keys) — free tier works |
| mails-agent mailbox + api_key | [mails0.com](https://mails0.com) — claim a free hosted mailbox, or [self-host](https://github.com/Digidai/mails) |

---

## Step 1 — Install (30s)

```bash
git clone https://github.com/Digidai/mails-gtm-agent.git
cd mails-gtm-agent
bun install
```

---

## Step 2 — Cloudflare resources (1 min)

```bash
# D1 database
wrangler d1 create mails-gtm
# 👆 copy the returned database_id — you'll paste it in step 3

# Queues (4 total: 2 main + 2 DLQ)
wrangler queues create mails-gtm-send
wrangler queues create mails-gtm-evaluate
wrangler queues create mails-gtm-dlq-send
wrangler queues create mails-gtm-dlq-evaluate
```

---

## Step 3 — Wire config (30s)

Edit `wrangler.toml`, replace the placeholder:

```diff
 [[d1_databases]]
 binding = "DB"
 database_name = "mails-gtm"
-database_id = "YOUR_D1_DATABASE_ID"
+database_id = "the-uuid-you-copied-in-step-2"
```

---

## Step 4 — Set secrets (30s)

```bash
wrangler secret put OPENROUTER_API_KEY        # paste your OpenRouter key
wrangler secret put MAILS_API_KEY              # paste your mails-agent api_key (mk_...)
wrangler secret put MAILS_MAILBOX              # e.g. you@mails0.com
wrangler secret put ADMIN_TOKEN                # any random 32+ char string
wrangler secret put UNSUBSCRIBE_SECRET         # any random 32+ char string (must differ from ADMIN_TOKEN)
```

Quick way to generate random tokens:

```bash
openssl rand -hex 32
```

---

## Step 5 — Init schema + deploy (1 min)

```bash
# Apply schema to your fresh D1
bun run db:init

# Deploy worker
bun run deploy
# 👆 note the deployed URL, e.g. https://mails-gtm-agent.yourname.workers.dev
```

---

## Step 6 — Create a smoke campaign + send one email (1 min)

Pick a name (your own email — you'll receive the test message).

```bash
# Export deploy URL + admin token so the CLI talks to your worker
export MAILS_GTM_API="https://mails-gtm-agent.yourname.workers.dev"
export MAILS_GTM_ADMIN_TOKEN="the-admin-token-you-set-in-step-4"

# Create a tiny campaign — agent engine with knowledge base auto-generated from the product URL
bun cli/index.ts campaign create \
  --name "Smoke Test" \
  --product-url "https://github.com/Digidai/mails-gtm-agent" \
  --address "123 Test Lane, Demo City, CA 94000" \
  --engine agent
# 👆 copy the returned campaign_id
```

Now import one contact (yourself):

```bash
cat > /tmp/smoke.csv <<EOF
email,name,company,role
you@example.com,Your Name,Your Company,Founder
EOF

bun cli/index.ts contacts import <campaign-id> --csv /tmp/smoke.csv
```

Activate the campaign — the cron (runs every minute on Cloudflare) will
pick up the contact and the agent will decide its first move:

```bash
bun cli/index.ts campaign update <campaign-id> --status active
```

Within 1-2 minutes, check your inbox.

---

## What just happened

1. `campaign create` saved a draft campaign and fetched your product URL
   through the LLM to build a **knowledge base** (product name, features,
   FAQ, competitors). See `src/knowledge/generate.ts`.
2. `contacts import` added you as a pending contact.
3. `campaign update --status active` flipped it to live.
4. The **agent cron** (10 min in production, runs every minute in dev)
   queued an evaluate job for your contact. See `src/scheduler/agent-cron.ts`.
5. The **evaluate consumer** asked the LLM "what next?" — it returned
   `{action: "send", step: 0}`. See `src/queue/evaluate-consumer.ts`.
6. The **send consumer** wrote a personalized email via the LLM, attached
   the CAN-SPAM compliance footer + List-Unsubscribe headers + RFC 8058
   one-click headers, sent through mails-agent, recorded the send. See
   `src/queue/send-consumer.ts`.

---

## Verify

```bash
# Stats — how many sends, opens (via tracking pixel), replies?
bun cli/index.ts campaign stats <campaign-id>

# Contact-by-contact status (pending / active / interested / unsubscribed / converted)
bun cli/index.ts contacts list <campaign-id>

# Tail the worker logs to see decisions
wrangler tail
```

---

## Cleanup

```bash
bun cli/index.ts campaign update <campaign-id> --status paused
```

To wipe data:

```bash
wrangler d1 execute mails-gtm --command="DELETE FROM campaign_contacts; DELETE FROM campaigns;"
```

---

## Common issues

| Symptom | Fix |
|---------|-----|
| `Missing OPENROUTER_API_KEY` | You set it as `.env` instead of via `wrangler secret put`. Secrets live in CF, not local files. |
| Email never sends | Check `wrangler tail`. Most often: `MAILS_API_KEY` is wrong, or your mails-agent mailbox is still in the 24h warm-up window (you cannot send for 24h after claim). |
| `Name already claimed` when creating campaign | The campaign already exists. `bun cli/index.ts campaign list` to see them. |
| `Knowledge base generation failed` | Product URL returns non-HTML, is behind auth, or LLM hit a rate limit. Pass `--description "..."` to skip the auto-KB step. |
| Empty inbox after 5 min | The cron runs every minute, but D1 propagation can lag. Check `wrangler tail` to see if the send actually fired. |

---

## Next steps

- **Real outreach**: swap the smoke CSV for a real list. Required columns: `email,name,company,role`. Any extra columns become template variables (e.g. `{{custom_field}}`).
- **Plug in CRM/Slack**: set `webhook_callback_url` on the campaign to receive `interested_reply` / `conversion` / `bounce` events.
- **MCP server**: run `bun mcp/index.ts` to expose the agent as an MCP server for Claude Code / Cursor / Windsurf.
- **Self-learning**: leave it running for a week — the agent records intent classifications and adapts. See `src/agent/decide.ts`.

For the full architecture, read `BUSINESS-FLOW.md`.
For legal/compliance responsibility, read `LEGAL.md`.
