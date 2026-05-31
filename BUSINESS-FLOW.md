# Business Flow

> Architecture and runtime behavior of `mails-gtm-agent`.
> For the full Chinese-language version (longer, more annotated):
> see [`BUSINESS-FLOW.zh.md`](./BUSINESS-FLOW.zh.md).

## 1. Product Positioning

`mails-gtm-agent` is an **AI SDR (Sales Development Representative) agent**
that runs cold outreach autonomously on Cloudflare Workers.

It is **not** a traditional sequence tool like Instantly / Smartlead.

| Traditional tool | mails-gtm-agent |
|------------------|-----------------|
| Human designs a fixed 3-step sequence | Human gives a product URL + a CSV |
| Tool executes on schedule | Agent reads the product, decides each step's content + timing |
| Human reads replies and follows up | Agent classifies reply intent and adapts strategy |
| Lives in SaaS, monthly fee | Lives in your Cloudflare account, free tier sufficient for hundreds of contacts/day |

Core differentiation: **open source · self-hosted · AI-native decisions · zero monthly fee**.

---

## 2. Technical Architecture

```
┌──────────────────────────────────────────────────────────┐
│                  mails-gtm-agent Worker                    │
│                                                            │
│  ┌───────────┐  ┌────────────┐  ┌──────────────────┐     │
│  │ HTTP API   │  │ Cron        │  │ Queue Consumers   │     │
│  │ /api/*     │  │ every 1 min │  │ evaluate + send   │     │
│  │ /t/:id     │  │             │  │ + DLQ consumers   │     │
│  │ /webhook/* │  │             │  │                   │     │
│  └─────┬─────┘  └─────┬──────┘  └────────┬──────────┘     │
│        │              │                   │                 │
│        └──────────────┼───────────────────┘                 │
│                       ▼                                     │
│  ┌────────────────────────────────────────────────────┐    │
│  │                 D1 (SQLite)                          │    │
│  │  campaigns | campaign_contacts | events | send_log  │    │
│  │  decision_log | tracked_links | unsubscribes        │    │
│  │  conversations | scheduled_replies                  │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────────┐   │
│  │ EVALUATE  │  │ SEND      │  │ Service Binding         │   │
│  │ QUEUE     │  │ QUEUE     │  │ → mails-worker (or HTTP) │   │
│  └──────────┘  └──────────┘  └────────────────────────┘   │
│                                                            │
│  ┌────────────────────────────────────────────────────┐    │
│  │       LLM gateway (OpenAI-API compatible)            │    │
│  │  default: EasyRouter · model: claude-sonnet-4        │    │
│  └────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

| Component | Tech |
|-----------|------|
| Runtime | Cloudflare Workers |
| Storage | D1 (SQLite) |
| Queueing | Cloudflare Queues (with dead letter queues) |
| LLM | Any OpenAI-API-compatible gateway. Default: EasyRouter with `anthropic/claude-sonnet-4`. Override via `LLM_BASE_URL` + `LLM_API_KEY` |
| Email send/receive | [mails-agent](https://github.com/Digidai/mails) |

---

## 3. User Operation Flow

```
You                                        System
───                                        ──────
1. Set up product URL + CSV            ──► Knowledge base generated from URL
2. Create campaign                     ──► campaigns row, status='draft'
3. Import contacts (CSV)               ──► campaign_contacts rows, status='pending'
4. Activate campaign (status='active') ──► Agent picks it up at next cron tick

                                       Cron (every 1 min)
                                       ──► For each active campaign:
                                       ──►   - Find pending contacts
                                       ──►   - Enqueue evaluate job

                                       Evaluate consumer
                                       ──► For each contact:
                                       ──►   - Load conversation context
                                       ──►   - Ask LLM: "send / wait / pause / stop"
                                       ──►   - Apply rule guards (max retries, etc.)
                                       ──►   - Enqueue send job OR schedule re-eval

                                       Send consumer
                                       ──► Generate email body (LLM template)
                                       ──► Attach CAN-SPAM footer + List-Unsubscribe headers
                                       ──► POST to mails-agent /api/send
                                       ──► Record in send_log
                                       ──► Update contact.last_sent_at

5. Recipient replies                   ──► Inbound webhook → classify intent
                                       ──► Update contact.status (interested / not_now / stopped)
                                       ──► If interested: notify owner via webhook
                                       ──► If unsubscribe: state machine → unsubscribed

6. Monitor / iterate                   ──► Stats API + tracking pixel + CLI
```

---

## 4. Agent's Autonomous Decision Loop

For every active contact, every ~10 min (configurable):

```ts
const decision = await llm.decide({
  contact,
  campaign,
  knowledgeBase,
  conversationHistory,   // every prior message in this thread
  events,                // opens, clicks, bounces
})

// decision = { action: 'send' | 'wait' | 'pause' | 'stop', step?: number, wait_hours?: number, reason: string }
```

`src/agent/decide.ts` calls the LLM with a structured prompt that includes the contact's full context. The LLM returns one of four actions:

| Action | Effect |
|--------|--------|
| `send` | Generate + send the next email at step N |
| `wait` | Re-evaluate in N hours (with ±24h jitter so cadence is variable) |
| `pause` | Mark contact as `not_now`, resume after `resume_date` if returned |
| `stop` | Mark contact as terminal (converted / unsubscribed / do_not_contact) |

**Rule guards** in `src/agent/rules.ts` override the LLM when something obviously wrong is requested (e.g. sending past `max_emails`, sending to an `unsubscribed` contact, etc.). Defense in depth — the LLM is creative but never the final authority on whether an email goes out.

---

## 5. Reply Classification and Handling

Inbound emails arrive via webhook from `mails-agent`:

```
POST /webhook/inbound  (HMAC-signed with WEBHOOK_SECRET)
{
  "from": "alice@acme.com",
  "subject": "Re: your email",
  "body_text": "Hey, interested. Can we chat next Tuesday?",
  "in_reply_to": "<msg-id-of-original@send.mails0.com>"
}
```

Pipeline:
1. **Match** — find the contact via `in_reply_to` header (thread-based matching)
2. **Classify** — LLM returns one of `interested | not_now | not_interested | wrong_person | out_of_office | unsubscribe | auto_reply | do_not_contact | unclear` with a confidence score
3. **State transition** — `state-machine.ts` applies priority-based status update (terminal statuses dominate; can't go from `converted` back to `active`)
4. **Auto-reply** — for `interested` replies, the agent generates a contextual reply, queues it with a 2–8h randomized delay (`reply-send-cron.ts`), and sends as a transactional message (RFC 5321 §3.6 / CAN-SPAM §7702(2): one-to-one replies are exempt from the bulk-message footer, but the original campaign message always carries the full footer)
5. **Notify** — fire owner webhook with `event=interested_reply` so a human can take over

A 5-min cron (`reply-cron.ts`) acts as a webhook-failure backstop, polling the inbox for unprocessed messages.

---

## 6. Link Tracking

Every URL embedded in an outbound email is replaced with a tracked redirect:

```
Original:  https://yourproduct.com/signup
Rewritten: https://your-worker.workers.dev/t/abc12345
```

Tracked links live in `tracked_links` and resolve via `/t/:id` with a 302. The click is recorded in `events` with the contact ID, then the redirect happens. The 8-char ID is non-sequential to avoid scraping.

`unsubscribe` links are excluded from rewriting — they bypass tracking on purpose so unsubscribing never costs the user any extra hop.

---

## 7. External Events (Webhooks)

| Endpoint | Purpose | Auth |
|----------|---------|------|
| `POST /webhook/inbound` | Inbound emails from `mails-agent` | HMAC-SHA256 (`WEBHOOK_SECRET`) |
| `POST /webhook/bounce` | Bounce notifications | HMAC-SHA256 |
| `POST /webhook/event` | Conversion / external signals | HMAC-SHA256 |

Outbound (the agent pushes to **your** systems):

```
POST <campaign.webhook_callback_url>
{
  "event": "interested_reply" | "conversion" | "bounce" | "unsubscribe" | "campaign_completed" | "dlq_failure",
  "campaign_id": "...",
  "contact_email": "...",
  "data": {...}
}
```

Used to plug into Slack / Discord / CRM / Linear.

---

## 8. Unsubscribe & Compliance Flow

Every outbound email carries:
- **Body footer**: physical mailing address + unsubscribe link
- **`List-Unsubscribe` header** (RFC 2369): `<https://your-worker/unsubscribe?token=...>, <mailto:unsubscribe@domain>`
- **`List-Unsubscribe-Post` header** (RFC 8058): one-click POST for Gmail/Yahoo bulk-sender requirements

Unsubscribe URL is HMAC-signed (`UNSUBSCRIBE_SECRET`, ≠ `ADMIN_TOKEN`) and valid for 1 year.

Reply-based unsubscribe: when the classifier returns `unsubscribe` or `do_not_contact`, the state machine updates immediately — no link click required.

GDPR data deletion: `POST /api/gdpr/delete` purges a contact across all tables (campaigns, events, send_log, conversations, tracked_links).

> See [`LEGAL.md`](./LEGAL.md) for the legal frameworks this tool scaffolds (CAN-SPAM / CASL / GDPR / PECR / Spam Act) and where responsibility ends.

---

## 9. Notification Mechanism

Owner is notified on:
- `interested_reply` (a contact responded with positive intent)
- `conversion` (a contact reached the conversion URL)
- `bounce` (hard bounce, contact stopped)
- `dlq_failure` (a message landed in the dead letter queue)

Channel: any URL set as the worker secret `WEBHOOK_URL` (Slack incoming webhook, Discord, custom HTTP endpoint).

---

## 10. Security Hardening

- **Token isolation**: `ADMIN_TOKEN` and `UNSUBSCRIBE_SECRET` must be different (enforced at startup)
- **HMAC verification** on every inbound webhook
- **Prompt injection mitigation**: every user-supplied field (name/company/role/CSV custom_fields) is sanitized before LLM input — common patterns like `ignore previous instructions`, `you are now`, `system:` etc. are neutralised. See `sanitizeForPrompt()` in `src/llm/generate.ts`.
- **SSRF defense**: knowledge-base generation only accepts `http://` and `https://` URLs (no `file://`, `gopher://`, internal IPs)
- **SQL parametrization**: every query uses bound parameters; no string interpolation into SQL
- **Atomic rate limits**: send counter uses increment-then-verify pattern to prevent race conditions across concurrent workers
- **State machine priority**: contact status transitions are priority-ranked so concurrent writers can't race-condition a contact back from `unsubscribed` → `active`
- **Token rotation**: tracked link IDs are non-sequential 8-char hex (32-bit entropy enough to defeat scraping)
- **DLQ + alerting**: messages exhausting `max_retries=3` land in a DLQ, get logged + notified instead of silently dropped

---

## 11. Data Model

```
campaigns
├── id (uuid)
├── name, product_name, product_description, from_email, sender_name
├── physical_address (required for CAN-SPAM)
├── status (draft / active / paused / completed)
├── engine (agent / sequence)
├── product_url, conversion_url
├── knowledge_base (JSON), knowledge_base_status
├── webhook_callback_url, webhook_secret
├── steps (JSON array — only used in 'sequence' engine)
├── max_emails, min_interval_days
├── daily_llm_calls, daily_llm_limit, daily_llm_reset_at
└── warmup_* (sender reputation ramp-up)

campaign_contacts
├── id (uuid), campaign_id (FK)
├── email, name, company, role, custom_fields (JSON)
├── status (pending / active / interested / converted / stopped /
│          unsubscribed / bounced / error / ...)
├── current_step, emails_sent
├── next_send_at, last_sent_at, resume_at
├── sent_message_id (last sent message id, for reply matching)
├── reply_intent, reply_confidence
└── converted_at, conversion_type, last_click_at

events                  one row per open / click / send / reply / bounce / etc.
send_log                immutable log of every outbound message
decision_log            audit trail of LLM decide() calls
tracked_links           short_id → original_url + click counter
unsubscribes            global + per-campaign unsubscribe records
conversations           thread-based message store (in_reply_to chain)
scheduled_replies       2-8h delayed auto-replies queued from the inbound pipeline
processed_messages      idempotency guard for webhook redeliveries
```

---

For step-by-step setup, see [`examples/quickstart.md`](./examples/quickstart.md).
For legal responsibility, see [`LEGAL.md`](./LEGAL.md).
