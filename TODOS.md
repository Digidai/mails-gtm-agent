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

## CEO Review (2026-04-09) — New Items

### [P0] Dead letter queue for Cloudflare Queues
**What:** Add `dead_letter_queue` to both SEND_QUEUE and EVALUATE_QUEUE consumers in wrangler.toml. Create DLQ consumer that retries recoverable failures and alerts on permanent ones.
**Why:** Currently max_retries=3 with no DLQ. When upstream (mails-worker or OpenRouter) has brief failures, messages are permanently dropped with zero trace. Contact's entire decision/send chain silently vanishes.
**Context:** wrangler.toml needs 3 lines per consumer. New `dlq-consumer.ts` for retry/alert logic. Included in SCOPE CORRECTION alongside compliance rollback.
**Effort:** S (human: ~1 day / CC: ~30min)
**Depends on:** None

### [P0] Compliance rollback (SCOPE CORRECTION)
**What:** Restore compliance footer (physical address + unsubscribe link) and List-Unsubscribe headers (including RFC 8058 one-click) in send-consumer and reply-cron. Update README compliance claims. Add LEGAL.md.
**Why:** Commits ee3142b + 7cc9b13 removed CAN-SPAM required elements. README still claims "CAN-SPAM / GDPR Compliance". Users unknowingly exposed to $51,744/email FTC penalties.
**Context:** Compliance code (headers.ts, unsubscribe.ts) is intact as dead code. Restore = re-activate ~15 lines of call sites. Keep all non-compliance "humanization" improvements (sanitizeEmail, frameworks, reply delay, persona signing).
**Effort:** S (human: ~1 day / CC: ~20min)
**Depends on:** None

### [P1] Integration tests for 5 core cron/consumer components
**What:** Add test files for evaluate-consumer, agent-cron, send-consumer, reply-send-cron, send-cron. All unit-level components have tests, but the "assembly line" integration is untested.
**Why:** Each component's internal logic is tested (decide.test, rules.test, compliance.test, etc.) but the wiring between them is not. Any mistake in message format, queue routing, or status transitions between components would go undetected.
**Context:** 26 existing test files cover 36 src files. The 5 missing files are all cron triggers or queue consumers — the most critical integration points.
**Effort:** M (human: ~3 days / CC: ~2h)
**Depends on:** None

### [P1] LLM error classification (429/timeout/parse differentiation)
**What:** Replace generic catch blocks in makeDecision/classifyReply with error-type-specific handling. 429 → campaign-level cooldown flag. Timeout → retry with truncated prompt. Parse error → log full LLM response for debugging.
**Why:** Current behavior: all LLM errors → fallback wait 3d. This means an OpenRouter outage makes the entire system stuck for 3 days per contact.
**Context:** TODOS.md already has "Campaign-level LLM cooldown" as P1. This extends it to cover all error types, not just 429.
**Effort:** M (human: ~2 days / CC: ~1h)
**Depends on:** None

### [P2] Global LLM quota guard
**What:** Add a SUM(daily_llm_calls) check across all campaigns before individual campaign evaluation.
**Why:** daily_llm_limit is per-campaign. 10 active campaigns each with limit=100 = 1000 LLM calls/day total. If OpenRouter account quota is lower, causes 429 storm.
**Context:** evaluate-consumer already has claimLlmQuota (atomic per-campaign). Need a global version.
**Effort:** S (human: ~1 day / CC: ~15min)
**Depends on:** None

### [P2] Health endpoint upgrade + post-deploy smoke test
**What:** Extend GET /health to check D1 connectivity, Queue availability, and mails-worker service binding health. Return structured JSON with component status.
**Why:** Current /health returns `{status: ok}` unconditionally. Post-deploy failures (broken D1 binding, wrong Queue name) are invisible until user reports.
**Context:** Foundation for automated post-deploy verification.
**Effort:** S (human: ~1 day / CC: ~30min)
**Depends on:** None

### [P2] Extract sanitizeForPrompt to shared module
**What:** Move sanitizeForPrompt from decide.ts and generate.ts to a shared utils/sanitize.ts.
**Why:** DRY violation. Identical function duplicated in two files. If one gets updated, the other drifts.
**Context:** Both copies are currently identical (same patterns, same max length).
**Effort:** XS (CC: ~10min)
**Depends on:** None

### Reply-cron pagination
**What:** Add pagination to reply-cron inbox fetch instead of fixed 100-message limit.
**Why:** High-volume periods or webhook outages could cause messages to fall off the 100-message window.
**Context:** Currently fetches max 100, processes max 10 per cycle. Event-driven webhook reduces urgency but cron is still the fallback.
**Effort:** S (human: ~1 day / CC: ~30min)
**Depends on:** None
