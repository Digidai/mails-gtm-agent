# AGENTS.md — orientation for AI coding agents

> If you are a human reader, skim or skip — this is a dense "system prompt"
> for AI coding agents (Codex / Claude Code / Cursor / Aider / Zed / etc).
> For human-friendly intro see [README.md](./README.md).

This file follows the [agents.md](https://agents.md) standard and is the
canonical brief for any agent working on this repo.

---

## 1. Project in one paragraph

`mails-gtm-agent` is an open-source **AI SDR (Sales Development Representative) agent**
that runs entirely on Cloudflare Workers + D1 + Queues. A user gives it a product
URL and a CSV of contacts; it autonomously generates personalized cold emails
(via an OpenAI-API-compatible LLM gateway, default EasyRouter), classifies
inbound replies, adapts strategy, and reports interested leads via outbound webhook.
CAN-SPAM compliant by default. Free on Cloudflare's free tier for up to a few
hundred contacts/day.

Email delivery (SMTP, Resend integration, inbound parsing) is handled by a
**separate** project `Digidai/mails` (the "mails-agent" worker, hosted at
`api.mails0.com`). This repo only handles SDR logic + LLM + orchestration.

---

## 2. Build, test, run commands

```bash
bun install           # one-time install
bun run typecheck     # tsc --noEmit; must be clean before commit
bun test              # 267 unit tests; must be green before commit
bun run dev           # local wrangler dev
bun run deploy        # wrangler deploy to Cloudflare Workers
bun run db:init       # apply schema.sql to remote D1
bun run smoke         # end-to-end production smoke test (creates a real campaign, polls KB, cleans up)
./bin/setup           # idempotent first-time bootstrap (CF account → D1 → queues → secrets → deploy)
```

Every PR must pass `bun run typecheck` AND `bun test`. CI enforces.

---

## 3. Architecture — where things live

```
src/
├── index.ts                   ENTRYPOINT — fetch/scheduled/queue routing
├── types.ts                   ALL TypeScript types (Env, Campaign, EvaluateMessage, ...)
├── state-machine.ts           Contact status transitions (canTransition + priority ranking)
├── agent/
│   ├── decide.ts              AGENT'S BRAIN — buildSystemPrompt + makeDecision + sanitizeEmail
│   └── rules.ts               Hard-coded guardrails (max_emails / no-response-streak)
├── llm/
│   ├── openrouter.ts          Universal LLM client (talks to EasyRouter / OpenRouter / OpenAI / any OpenAI-API-compatible gateway). DESPITE THE FILENAME — provider is configurable via env. See resolveLlmConfig().
│   ├── classify.ts            Classifies inbound replies into 9 intents
│   ├── generate.ts            Generates the cold email body
│   ├── reply.ts               Generates the auto-reply for interested contacts
│   └── review.ts              Pre-send reviewer: rejects → safe template fallback
├── knowledge/
│   └── generate.ts            Fetches product URL → extracts structured KB JSON via LLM
├── scheduler/
│   ├── agent-cron.ts          Every 10 min: enqueue evaluate jobs for active contacts
│   ├── send-cron.ts           Every 1 min: legacy v1 sequence-engine sender
│   ├── reply-cron.ts          Every 5 min: webhook-failure backstop for inbound replies
│   └── reply-send-cron.ts     Every 1 min: drains scheduled_replies whose send_at has passed
├── queue/
│   ├── evaluate-consumer.ts   Consumes EVALUATE_QUEUE: decide → send/wait/stop. Also handles generate_kb messages (async KB gen).
│   ├── send-consumer.ts       Consumes SEND_QUEUE: writes CAN-SPAM headers + footer, calls mails-agent /v1/send, classifies errors.
│   └── dlq-consumer.ts        Drains dead-letter queues + alerts owner.
├── routes/
│   ├── campaign.ts            POST /api/campaign/create + start + pause + refresh
│   ├── contacts.ts            POST /api/contacts/import (CSV)
│   ├── inbound-webhook.ts     POST /webhook/inbound from mails-agent (HMAC-signed)
│   ├── bounce-webhook.ts      POST /webhook/bounce
│   ├── unsubscribe.ts         GET/POST /unsubscribe?token=...
│   ├── gdpr.ts                POST /api/gdpr/delete
│   ├── stats.ts               GET /api/campaign/:id/stats
│   ├── preview.ts             POST /api/campaign/:id/preview (dry-run email generation)
│   └── steps.ts               GET/POST /api/campaign/:id/steps (sequence engine only)
├── tracking/
│   └── links.ts               Replace URLs in body with /r/:id short tracked redirects
├── compliance/
│   ├── headers.ts             List-Unsubscribe / List-Unsubscribe-Post (RFC 2369 + 8058)
│   └── unsubscribe.ts         HMAC-signed unsubscribe token (1y validity)
├── conversations/
│   └── context.ts             Persisted message history for inbound thread matching
├── events/
│   ├── record.ts              Append to events table
│   └── webhook.ts             Outbound webhook to campaign.webhook_callback_url
├── tracking/links.ts          (mentioned above)
├── utils/
│   ├── csv.ts                 CSV parser for contact import
│   ├── llm-quota.ts           Atomic daily LLM call counter
│   └── warmup.ts              Sender-reputation ramp-up math
├── notify.ts                  Owner notifications (Slack/Discord webhook)
└── state-machine.ts           (mentioned above)

test/unit/                     267 tests · run with `bun test`
cli/                           `mails-gtm` CLI binary
mcp/                           MCP server (Claude Code / Cursor / Windsurf integration)
migrations/                    D1 schema migrations (001 → 005)
schema.sql                     Full schema for fresh deployments
scripts/smoke.ts               Production smoke test (run via `bun run smoke`)
bin/setup                      One-command bootstrap
examples/quickstart.md         5-minute step-by-step setup for humans
BUSINESS-FLOW.md / .zh.md      Full architecture write-up
LEGAL.md                       CAN-SPAM / GDPR / CASL responsibilities
TODOS.md                       Deferred work (P0/P1/P2)
```

---

## 4. Mental model of the runtime

```
Browser/CLI → POST /api/campaign/create
              ↓ writes campaigns row
              ↓ enqueues GenerateKbMessage to EVALUATE_QUEUE (async KB gen — does NOT block response)
              ↓ returns 201 with campaign_id

Browser/CLI → POST /api/contacts/import (csv body)
              ↓ INSERTs campaign_contacts rows

Browser/CLI → POST /api/campaign/:id/start
              ↓ UPDATE campaigns SET status='active'

Cloudflare cron, every minute → src/index.ts:scheduled handler
              ├── sendCron (v1 sequence engine; pre-defined steps)
              ├── replySendCron (drain scheduled_replies whose send_at is now)
              ├── agentCron (only on minute % 10 — v2 agent engine)
              │     ├── For each active campaign:
              │     │   ├── reset daily LLM counter if midnight UTC
              │     │   ├── promote not_now → pending if resume_at passed
              │     │   ├── pick 50 pending/active contacts due for eval
              │     │   ├── 15-min dedup (last_enqueued_at), atomic claim
              │     │   └── enqueue EvaluateMessage → EVALUATE_QUEUE
              └── replyCron (only on minute % 5 — fallback for missed webhooks)

EVALUATE_QUEUE → evaluate-consumer
              ├── If type='generate_kb': fetch URL, LLM extract, write KB
              └── If type='evaluate':
                    ├── claimLlmQuota (atomic per-campaign daily limit)
                    ├── load contact + events + KB
                    ├── makeDecision(LLM) → { action: send | wait | stop }
                    ├── If send → reviewEmail(LLM) → sanitizeEmail → tracking links
                    ├── re-check contact status (race guard vs inbound webhook)
                    └── enqueue AgentSendMessage → SEND_QUEUE

SEND_QUEUE → send-consumer
              ├── decision_id idempotency check
              ├── claim global daily slot (atomic)
              ├── attach CAN-SPAM footer + List-Unsubscribe headers
              ├── POST to mails-agent /v1/send (uses MAILS_API_KEY)
              ├── classify error 401/403 → pause campaign + notify
              ├── classify error 400/422 → mark contact 'error'
              └── INSERT send_log + events

mails-agent (separate worker) receives reply → POST /webhook/inbound HMAC-signed
              ├── verify HMAC v2 (with timestamp window)
              ├── self-reply protection (from == MAILS_MAILBOX)
              ├── processed_messages dedup
              ├── thread match via In-Reply-To → contact
              ├── auto-responder header short-circuit (skips classification)
              ├── classifyReply(LLM) → { intent, confidence }
              ├── confidence < 0.7 → coerced 'unclear'
              └── handleIntent → state-machine.updateContactStatus(...)
                    ├── interested → scheduleReply (2-8h delay, jittered)
                    ├── not_now → resume_at = now + 30 days
                    ├── unsubscribe → status terminal + INSERT unsubscribes
                    ├── wrong_person → allows reclassification later
                    └── ...
```

---

## 5. State machine — priority-based transitions

`src/state-machine.ts` is the SINGLE source of truth for contact status changes.
All status writes should go through `updateContactStatus(db, id, newStatus, extra)`.
Direct UPDATEs are allowed ONLY for bulk operations (e.g. cross-campaign unsubscribe
in `src/routes/unsubscribe.ts`) and they must comment WHY they bypass.

Priority order (lower number = higher priority, cannot be overridden by lower):

```
0  do_not_contact         <- highest priority, hardest sticky
1  unsubscribed
2  bounced
3  converted
4  interested              <- terminal in agent engine
5  stopped
6  error
7  not_interested
8  wrong_person            <- SPECIAL: can transition to anything (reclassify)
9  not_now                 <- SPECIAL: can transition to pending (resume_at expiry)
10 replied
11 active
12 queued
13 sent
14 pending                 <- lowest, fresh state
```

Two exceptions to "only higher priority wins":
- `not_now → pending` (resume)
- `wrong_person → ANY` (reclassification)

Both encoded in `canTransition()`. Don't add more exceptions without strong reason.

---

## 6. Common tasks — cookbook

### Add a new reply intent

1. Add to `IntentType` in `src/types.ts`
2. Add to `IntentTypes` array literal in `src/llm/classify.ts`
3. Update the classifier system prompt in `src/llm/classify.ts` with the new intent's definition
4. Add a case in `handleIntent` in `src/scheduler/reply-cron.ts` to map intent → status
5. Add a test in `test/unit/classify.test.ts`
6. `bun test && bun run typecheck`

### Change the cold email writing style

1. Edit `EMAIL_FRAMEWORKS`, `OPENING_STYLES`, `CTA_STYLES` in `src/agent/decide.ts`
2. Update `buildSystemPrompt()` rules
3. Add post-generation guards to `sanitizeEmail()` if needed
4. Run `bun run smoke` to verify a real campaign still produces valid emails

### Add a new API endpoint

1. Decide route (`/api/...`) and HTTP method
2. Add handler in appropriate `src/routes/*.ts`
3. Register in `handleCampaignRoutes()` / `handleContactsRoutes()` / `src/index.ts` switch
4. Add Bearer auth check (compare to env.ADMIN_TOKEN)
5. Add a unit test in `test/unit/`

### Switch LLM provider

Default is EasyRouter. To switch:

```bash
# OpenAI directly
wrangler secret put LLM_API_KEY      # paste OpenAI key
wrangler secret put LLM_BASE_URL     # https://api.openai.com/v1/chat/completions
wrangler secret put LLM_MODEL        # gpt-4o

# Anthropic via OpenRouter
wrangler secret put LLM_API_KEY      # paste OpenRouter key
wrangler secret put LLM_BASE_URL     # https://openrouter.ai/api/v1/chat/completions
wrangler secret put LLM_MODEL        # anthropic/claude-sonnet-4

# Anthropic via EasyRouter (default)
wrangler secret put LLM_API_KEY      # paste EasyRouter key
# LLM_BASE_URL omitted — defaults to easyrouter.io
wrangler secret put LLM_MODEL        # claude-sonnet-4-6
```

---

## 7. Known gotchas — read these BEFORE writing code

1. **`anthropic/claude-sonnet-4` is OpenRouter's name; EasyRouter uses `claude-sonnet-4-6`.**
   Other providers have other names. Always set `LLM_MODEL` explicitly when switching.

2. **Knowledge-base generation is ASYNC** (via EVALUATE_QUEUE). Code path:
   `POST /api/campaign/create` returns 201 immediately with `knowledge_base_status='generating'`.
   The actual KB gen takes 10-40s via the queue. Don't expect `knowledge_base` to be
   populated synchronously. `POST /api/campaign/:id/start` is blocked while
   `knowledge_base_status='generating'`.

3. **LLM responses are often wrapped in markdown code fences.**
   `src/llm/openrouter.ts:extractJson()` strips them before parsing. Always reuse this —
   don't `JSON.parse(rawResponse)` directly.

4. **`agent-cron` runs every 10 min in production**, not every 1 min. First email after
   `campaign start` takes 0-10 minutes to appear. Set `DEV_MODE=true` (via
   `wrangler secret put DEV_MODE` or `--var DEV_MODE:true` in `wrangler dev`) to
   bypass the `minute % 10` / `minute % 5` gates so both crons fire every minute,
   AND to shrink `scheduleReply()`'s human-like 2-8 HOUR delay to 2-8 SECONDS.
   Smoke tests complete in ~1 minute with DEV_MODE; NEVER enable on production —
   automation looks robotic and burns quota.

5. **Timestamp format is ISO-8601 T+Z**, NOT SQLite's `datetime('now')` (space-separated).
   String comparisons `'T' (0x54) > ' ' (0x20)` silently break invariants. Always use
   `new Date().toISOString()` for any `updated_at` / `last_*_at` write to
   `campaign_contacts`. See commit `444b293` for the historical bug fix.

6. **The send path requires a non-empty `physical_address`** (CAN-SPAM defense-in-depth).
   Test campaigns must set one (any string OK).

7. **`mails-agent` (the email-delivery worker) is a SEPARATE project at
   `Digidai/mails`.** It must be deployed, the recipient mailbox must have its
   webhook_url pointing to this worker's `/webhook/inbound`, and `WEBHOOK_SECRET`
   must match between the two. Without this, replies never reach the gtm-agent
   and every persona stays stuck in `active`.

8. **LLM call timeout is 45s.** Don't increase casually — CF Workers queue consumer
   wall-clock is ~30s; the 45s timeout is already > one consumer invocation.
   The retry+timeout combination is delicate.

9. **`max_tokens=4096` was bumped up from 1024 to accommodate KB extraction.**
   Don't lower without checking that KB JSON still fits. KB output can be 4-5KB.

10. **Production D1 IDs**:
    - `mails-gtm` (this project): `f5d0f258-ce84-4d8b-a43d-d4044549cc1e`
    - `mails` (mails-agent): `300b8760-fc02-4b1d-b0c1-bb560ec3b65e`
    Both visible in `wrangler d1 list`. Do NOT commit these to public configs (they're
    in env / wrangler.toml as `YOUR_D1_DATABASE_ID` placeholder).

---

## 8. Testing & validation gates

```bash
# Before every commit:
bun run typecheck       # must be 0 errors
bun test                # must be 267+ passing

# Before every deploy:
bun run deploy
bun run smoke           # creates a tiny campaign on PROD, verifies KB gen via real LLM call, cleans up. ~60s.

# Debugging a failed campaign:
wrangler tail --format=pretty
# Then trigger the path you suspect — logs stream in real-time.

# Inspecting production state:
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://mails-gtm-agent.genedai.workers.dev/api/admin/info
# Returns secrets-configured, queue depth, recent errors, active campaign count.
```

---

## 9. Commit / PR conventions

- **Conventional Commits** style: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`
- Subject ≤ 70 chars, lowercase after type prefix
- Body explains WHY in prose, then enumerates files changed
- Add `Co-Authored-By:` trailer when an agent wrote the change
- Squash commits before merge to `master`

---

## 10. Security responsibilities

This code ships **scaffolding** for CAN-SPAM / GDPR / CASL compliance, not
turnkey compliance. See [LEGAL.md](./LEGAL.md) for what's covered and what's
the operator's responsibility.

Specific security invariants any change must preserve:

- `UNSUBSCRIBE_SECRET` must differ from `ADMIN_TOKEN`
- HMAC signature verification on `/webhook/inbound` (with timestamp window)
- Bearer `ADMIN_TOKEN` on every `/api/*` write endpoint
- Prompt injection sanitization (`sanitizeForPrompt()`) on all user-supplied fields fed to LLM
- SSRF defense on `product_url` (only `http://` and `https://` accepted)
- SQL parametrized everywhere — never string-interpolate into SQL
- Atomic rate limit counters via D1 INSERT-OR-INCREMENT (not read-then-write)

---

## 11. Where deferred work lives

`TODOS.md` lists deferred P0/P1/P2 items from code reviews. Newest at top.
Resolve items there before opening unrelated PRs.

`scripts/smoke.ts` covers the happy path end-to-end. **Adversarial / edge cases**
(DLQ behavior, LLM 429 cooldown, 401 campaign pause, hard rules max_emails) are
NOT in the smoke test — they're tested via the dress-rehearsal harness archived
at `/tmp/dress-rehearsal/` (see `RESULTS_RAW.md` for the May 31 run).

---

## 12. Don'ts

- Don't `JSON.parse` LLM output directly. Use `extractJson()`.
- Don't `datetime('now')` on `campaign_contacts` columns. Use `new Date().toISOString()`.
- Don't bypass `updateContactStatus()` unless doing a bulk cross-campaign operation (and comment why).
- Don't add new env vars without updating `Env` interface in `src/types.ts` AND `.env.example`.
- Don't hardcode the LLM provider URL. Use `resolveLlmConfig()`.
- Don't widen the 9-intent classification taxonomy without updating the state machine + tests.
- Don't introduce new global mutable state in Workers (no `let counter = 0` at module scope — survives across requests).
- Don't commit secrets (api keys, tokens, D1 IDs of real accounts). Use `.env.example` placeholders.
