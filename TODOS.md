# TODOS — mails-gtm-agent

Deferred items from CEO Review (2026-04-03) and Codex Eng Review (2026-04-04).

## P1 — Next Sprint

### Multi-mailbox rotation
**What:** Support multiple sender email addresses per campaign, rotate between them.
**Why:** Improves deliverability at scale. Single sender address gets flagged faster by spam filters.
**Context:** Currently `from_email` is a single field on campaigns table. Need to add a `campaign_mailboxes` join table, rotation logic in send-consumer, and warmup per-mailbox tracking.
**Effort:** M (human: ~1 week / CC: ~3h)
**Depends on:** None

### Reply-cron + inbound-webhook shared service extraction
**What:** Extract shared reply processing logic (contact matching, classify, handleIntent) into a dedicated `src/services/reply-processor.ts`.
**Why:** Codex flagged that reply-cron and inbound-webhook duplicate the flow and have already drifted (parameter mismatch bug). A shared service prevents future drift.
**Context:** Currently inbound-webhook imports functions from reply-cron. Works but fragile. A service class with `processInboundEmail(env, emailData)` would be cleaner.
**Effort:** M (human: ~3 days / CC: ~1h)
**Depends on:** None

### Campaign-level LLM cooldown
**What:** When OpenRouter returns 429, mark the campaign as "cooling down" in DB. Next cron cycle skips it.
**Why:** Current retry is per-request (2 attempts). Campaign-level cooldown prevents hammering a rate-limited provider across many contacts.
**Context:** CEO review option C for retry strategy. Deferred in favor of simpler per-request retry.
**Effort:** S (human: ~1 day / CC: ~30min)
**Depends on:** None

### KB generation as async job
**What:** Move knowledge base generation out of the synchronous campaign creation API path into a background queue job.
**Why:** Codex flagged that synchronous KB gen (fetch URL + LLM extraction) blocks the API request. Timeout leaves campaign in stuck state.
**Context:** Currently uses ctx.waitUntil for the generation, but still runs in the request lifecycle. Should use EVALUATE_QUEUE or a dedicated KB_QUEUE.
**Effort:** M (human: ~3 days / CC: ~1h)
**Depends on:** None

## P2 — Future

### Multi-tenant auth
**What:** Replace single ADMIN_TOKEN with per-campaign or per-user auth (JWT with campaign_id claims).
**Why:** Required for SaaS offering. Current model only supports single-user/single-org deployments.
**Context:** Significant rework. Auth middleware, token management, data isolation.
**Effort:** XL (human: ~3 weeks / CC: ~6h)
**Depends on:** Product decision on pricing/billing model

### Web UI dashboard
**What:** Build a web interface for campaign management, analytics, and contact monitoring.
**Why:** CLI + API is sufficient for developers but limits adoption by non-technical users.
**Context:** mails-web (mails0.com) has a console — could extend it, or build standalone.
**Effort:** XL (human: ~4 weeks / CC: ~8h)
**Depends on:** Multi-tenant auth (for user sessions)

### A/B testing framework
**What:** Formal A/B testing with statistical significance for email angles, subject lines, and send timing.
**Why:** Current self-learning (angle stats) is primitive — no control group, no significance testing.
**Context:** Would need a `experiments` table, variant assignment logic, and stats calculation.
**Effort:** L (human: ~2 weeks / CC: ~4h)
**Depends on:** None

### Advanced warmup engine
**What:** Per-mailbox warmup with inbox placement monitoring, send reputation tracking, and automatic throttling.
**Why:** Current warmup is just volume ramping. Real warmup needs to monitor bounce rates and adjust.
**Context:** Basic warmup exists (calculateDailyLimit in utils/warmup.ts). Advanced version needs bounce rate integration.
**Effort:** L (human: ~2 weeks / CC: ~4h)
**Depends on:** Multi-mailbox rotation

### Unsubscribes memory optimization
**What:** Replace full-table unsubscribes load during CSV import with a Bloom filter or batch EXISTS query.
**Why:** Codex flagged that importing contacts loads entire unsubscribes table into memory. Will slow down as suppression list grows.
**Context:** `src/routes/contacts.ts:117` — loads all unsubscribes into a Set. Replace with batch IN query or add an index-based check.
**Effort:** S (human: ~1 day / CC: ~30min)
**Depends on:** None

### Reply-cron pagination
**What:** Add pagination to reply-cron inbox fetch instead of fixed 100-message limit.
**Why:** High-volume periods or webhook outages could cause messages to fall off the 100-message window.
**Context:** Currently fetches max 100, processes max 10 per cycle. Event-driven webhook reduces urgency but cron is still the fallback.
**Effort:** S (human: ~1 day / CC: ~30min)
**Depends on:** None
