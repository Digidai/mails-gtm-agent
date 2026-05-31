# mails-gtm-agent 业务流程文档

## 1. 产品定位

**mails-gtm-agent 是一个 AI 自主冷邮件外联 Agent。**

它不是传统的邮件序列工具（如 Instantly/Smartlead），而是一个自主决策的 AI Agent：
- 传统工具：人设计 3 步固定序列 → 工具按时间执行 → 人跟进回复
- mails-gtm-agent：人提供产品 URL + CSV → Agent 自己理解产品 → 自主决定每封邮件内容和时机 → 追踪行为 → 根据行为调整策略 → 直到转化或放弃

**核心差异化：** 开源 + 自托管 + AI 原生决策 + 零月费

## 2. 技术架构

```
┌─────────────────────────────────────────────────────┐
│                mails-gtm-agent Worker                 │
│                                                       │
│  ┌────────────┐  ┌─────────────┐  ┌───────────────┐ │
│  │ HTTP API    │  │ Cron Trigger │  │ Queue Consumer│ │
│  │ /api/*      │  │ 每分钟       │  │ evaluate +   │ │
│  │ /t/:id      │  │             │  │ send          │ │
│  │ /webhook/*  │  │             │  │               │ │
│  │ /unsubscribe│  │             │  │               │ │
│  └──────┬─────┘  └──────┬──────┘  └──────┬────────┘ │
│         │               │                │           │
│         └───────────────┼────────────────┘           │
│                         │                             │
│  ┌──────────────────────▼───────────────────────┐    │
│  │                   D1 数据库                    │    │
│  │  campaigns | contacts | events | send_log    │    │
│  │  decision_log | tracked_links | unsubscribes │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ EVALUATE  │  │ SEND         │  │ Service Binding│ │
│  │ QUEUE     │  │ QUEUE        │  │ → mails-worker │ │
│  └──────────┘  └──────────────┘  └────────────────┘ │
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │              OpenRouter LLM                    │    │
│  │         anthropic/claude-sonnet-4              │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

## 3. 完整用户操作流程

```
用户操作                                    系统行为
────────                                    ────────

Step 1: 部署
  wrangler deploy                        → Worker 部署到 Cloudflare
  wrangler secret put ADMIN_TOKEN        → 设置管理密码
  wrangler secret put OPENROUTER_API_KEY → 设置 LLM API key
  wrangler secret put MAILS_API_KEY      → 设置 mails-agent token

Step 2: 创建 Campaign
  POST /api/campaign/create              → 系统自动：
  {                                         1. 调用 md.genedai.me 抓取产品页
    name, product_url,                      2. 用 LLM 从 Markdown 提取知识库
    conversion_url,                         3. 生成 webhook_secret
    physical_address                        4. 保存到 D1
  }                                         返回：campaign_id + webhook_secret

  文件: src/routes/campaign.ts → createCampaign()
  文件: src/knowledge/generate.ts → generateKnowledgeBase()

Step 3: 导入联系人
  POST /api/contacts/import              → 系统自动：
  { campaign_id, csv: "..." }               1. 解析 CSV (email,name,company,role)
                                            2. 验证 email 格式
                                            3. 去重 (ON CONFLICT DO NOTHING)
                                            4. 检查全局退订列表
                                            5. 插入 campaign_contacts

  文件: src/routes/contacts.ts → importContacts()
  文件: src/utils/csv.ts → parseCSV()

Step 4: 预览（可选）
  POST /api/campaign/:id/preview         → 系统自动：
  { count: 3 }                              1. 取 N 个 pending 联系人
                                            2. 调用 Agent 决策引擎
                                            3. 返回生成的邮件（不发送）

  文件: src/routes/preview.ts → previewEmails()

Step 5: 启动
  POST /api/campaign/:id/start           → campaign.status = 'active'
                                            cron 开始自动运行

Step 6: 查看进度
  GET /api/campaign/:id/stats            → 统计：sent/clicked/replied/converted
  GET /api/campaign/:id/decisions        → Agent 每次决策的理由
  GET /api/campaign/:id/events           → 完整事件流
```

## 4. Agent 自主决策流程

```
                    Cron 每分钟触发
                    (minute % 10 === 0 时执行)
                          │
                          ▼
            ┌─────────────────────────────┐
            │  agent-cron.ts              │
            │  agentCron()                │
            │                             │
            │  1. 查活跃 agent campaigns  │
            │  2. 重置过期 LLM 计数       │
            │  3. 恢复 not_now 到期联系人  │
            │  4. SELECT 待评估联系人      │
            │     WHERE status IN         │
            │     ('pending','active')    │
            │     AND next_check_at ≤ now │
            │     AND last_enqueued_at    │
            │         < now - 15min       │
            │  5. UPDATE last_enqueued_at │
            │  6. 入队 EVALUATE_QUEUE     │
            └──────────────┬──────────────┘
                           │
                           ▼
            ┌─────────────────────────────┐
            │  evaluate-consumer.ts       │
            │  evaluateConsumer()         │
            │                             │
            │  1. 获取 campaign + contact │
            │  2. 检查 campaign.status    │
            │     = 'active'              │
            │  3. 检查终态               │
            │  4. 获取 knowledge_base     │
            │  5. 获取 last 20 events     │
            │  6. 检查 daily_llm_limit    │
            └──────────────┬──────────────┘
                           │
                    ┌──────▼──────┐
                    │  硬规则检查   │ ← rules.ts checkHardRules()
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
           stop         wait        evaluate
           │            │            │
           │            │            ▼
           │            │    ┌──────────────┐
           │            │    │ LLM 决策     │ ← decide.ts makeDecision()
           │            │    │              │
           │            │    │ 输入:        │
           │            │    │ - 知识库 JSON│
           │            │    │ - 联系人信息 │
           │            │    │ - 事件时间线 │
           │            │    │ - 状态信息   │
           │            │    │              │
           │            │    │ 输出:        │
           │            │    │ { action,    │
           │            │    │   reasoning, │
           │            │    │   email,     │
           │            │    │   wait_days }│
           │            │    └──────┬───────┘
           │            │           │
           ▼            ▼           ▼
    status=stopped  next_check  ┌────────────────┐
    记录 decision   = now +     │ 链接追踪替换    │
    log             wait_days   │ 追踪链接入 D1   │
                    记录 log    │ 合规 footer     │
                                │ 全局发送限额检查│
                                └────────┬───────┘
                                         │
                                    SEND_QUEUE
                                         │
                                         ▼
                                ┌────────────────┐
                                │ send-consumer   │
                                │                 │
                                │ 1. 幂等检查     │
                                │    (decision_id)│
                                │ 2. 终态检查     │
                                │ 3. 退订检查     │
                                │ 4. campaign     │
                                │    status检查   │
                                │ 5. 物理地址检查 │
                                │ 6. mailsFetch   │
                                │    /v1/send     │
                                │ 7. 记录 events  │
                                │    + send_log   │
                                │    + daily_stats│
                                └────────────────┘

硬规则（代码强制，不走 LLM）:
  ┌──────────────────────────────────────────┐
  │ 1. emails_sent >= max_emails (默认6) → stop │
  │ 2. last_sent < min_interval (默认2天) → wait │
  │ 3. 连续3封无响应(无点击/无回复) → stop     │
  │ 4. 终态(converted/stopped/unsubscribed     │
  │    /bounced/do_not_contact/interested) → stop│
  │ 5. daily_llm_calls >= limit → skip          │
  └──────────────────────────────────────────┘
```

## 5. 回复检测和处理流程

```
                    Cron 每分钟触发
                    (minute % 5 === 0 时执行)
                          │
                          ▼
            ┌─────────────────────────────┐
            │  reply-cron.ts              │
            │  replyCron()                │
            │                             │
            │  1. 获取全局 inbox cursor   │
            │     MAX(last_inbox_check_at)│
            │  2. Service Binding 调用    │
            │     mails-agent             │
            │     GET /v1/inbox           │
            │     ?direction=inbound      │
            │     &limit=100              │
            │  3. 客户端时间过滤          │
            │     received_at > since     │
            └──────────────┬──────────────┘
                           │
              对每封 inbound 邮件：
                           │
                           ▼
            ┌─────────────────────────────┐
            │  去重检查                    │
            │  msg_id 是否已在 events 中？ │
            │  → 已处理则跳过             │
            └──────────────┬──────────────┘
                           │
                           ▼
            ┌─────────────────────────────┐
            │  联系人匹配                  │
            │  WHERE email = from_address │
            │  AND status IN              │
            │    ('sent','replied','active')│
            │  AND last_sent_at IS NOT NULL│
            │  ORDER BY last_sent_at DESC │
            │  LIMIT 1                    │
            └──────────────┬──────────────┘
                           │
                           ▼
            ┌─────────────────────────────┐
            │  获取邮件正文                │
            │  GET /v1/email?id=msg.id    │
            │  (inbox 列表不含 body)      │
            └──────────────┬──────────────┘
                           │
                           ▼
            ┌─────────────────────────────┐
            │  LLM 意图分类               │ ← classify.ts classifyReply()
            │  输入: 回复正文              │
            │  输出: { intent,            │
            │    confidence, resume_date } │
            │                             │
            │  confidence < 0.7 → unclear │
            └──────────────┬──────────────┘
                           │
           ┌───────┬───────┼───────┬───────────┐
           ▼       ▼       ▼       ▼           ▼
      interested  not_now  not_    wrong_    unsub/
                           interested person  DNC
           │       │       │       │           │
           │   resume_at   │    status=     全局退订
           │   =now+30d    │   wrong_person  +通知
           │       │       │       │           │
           ▼       ▼       ▼       ▼           ▼
        status=  status=  status=  status=   status=
        interested not_now stopped  wrong_   do_not_
        +通知owner         (终态)  person   contact
        (终态)                               (终态)
```

**10 种意图分类：**

| 意图 | 动作 | 是否终态 |
|------|------|---------|
| interested | 标记+通知 owner | 是 |
| not_now | 暂停，resume_at 后恢复 | 否 |
| not_interested | 停止序列 | 是 |
| wrong_person | 标记 | 否 |
| out_of_office | 保持现状 | 否 |
| unsubscribe | 全局退订 | 是 |
| auto_reply | 忽略 | 否 |
| do_not_contact | 全局退订+黑名单 | 是 |
| unclear | 标记待人工审查 | 否 |
| bounced | 停止 | 是 |

## 6. 链接追踪流程

```
邮件生成时:
  "Check it out: https://mails0.com"
       │
       ▼  tracking/links.ts replaceLinksWithTracking()
  排除退订/隐私链接 → 创建 tracked_links 记录
       │
       ▼
  "Check it out: https://mails-gtm-agent.workers.dev/t/abc123"

收件人点击时:
  GET /t/abc123
       │
       ▼  index.ts 路由
  1. 查 D1 tracked_links (id=abc123)
  2. 验证 URL 协议 (http/https only)
  3. 点击去重检查 (同 contact+link 只记一次)
  4. 记录 events (link_click)
  5. 更新 contact.last_click_at
  6. 302 重定向到原始 URL

下次 Agent 评估时:
  events 中有 link_click → LLM 看到"点击了但没注册"
  → 可能决定发产品深度介绍
```

## 7. 外部事件（Webhook）流程

```
产品注册/付费时:
  POST /webhook/event/:campaign_id
  {
    "email": "alice@acme.com",
    "event": "signup",
    "timestamp": "2026-03-29T10:00:00Z"
  }
  X-Webhook-Signature: <HMAC-SHA256>
       │
       ▼  events/webhook.ts handleWebhookEvent()
  1. 查 campaign + webhook_secret
  2. HMAC-SHA256 签名验证 (timing-safe)
  3. timestamp 窗口检查 (±5分钟)
  4. 匹配 email → campaign_contacts
  5. 记录 events (signup/payment)
  6. 更新 contact: converted_at, conversion_type
  7. 通知 owner
       │
       ▼
  下次 Agent 评估时:
  → 硬规则: 已转化 → 发感谢邮件 → stop
```

## 8. 退订合规流程

```
每封邮件底部:
  "---
   Remote, Global
   To unsubscribe: https://mails-gtm-agent.workers.dev/unsubscribe?token=eyJ..."

收件人点击:
  GET /unsubscribe?token=...
       │
       ▼  routes/unsubscribe.ts
  1. 验证 HMAC token (email + campaign_id + expiry)
  2. 显示确认页面 "Are you sure?"
       │
       ▼  (用户点击 Confirm)
  POST /unsubscribe?token=...
       │
       ▼
  1. 再次验证 token
  2. DB.batch() 原子操作:
     a. INSERT unsubscribes (campaign 级)
     b. INSERT unsubscribes (全局 __global__)
     c. UPDATE 所有 campaign 中该 email 的 contacts → status='unsubscribed'
  3. 成功 → 显示 "已退订"
     失败 → 显示 "操作失败请重试" (500)

多层防护:
  - send-consumer: 发送前查 unsubscribes 表
  - agent-cron: 只选非终态联系人
  - evaluate-consumer: 再次检查终态
  - reply-cron: 不匹配已退订联系人
```

## 9. 通知机制

| 事件 | 通知内容 | 通知方式 |
|------|---------|---------|
| 回复分类为 interested | "[mails-gtm] Interested reply from {email}" | 邮件到 campaign mailbox |
| 外部 webhook: signup/payment | "[mails-gtm] New conversion: {email}" | 邮件到 campaign mailbox |
| 401/403 API 错误 | "[mails-gtm] Campaign paused: {name}" | 邮件到 campaign mailbox |

文件: src/notify.ts → notifyOwner()
通过 Service Binding 调用 mails-agent POST /v1/send

## 10. 安全防护

| 防护 | 实现 |
|------|------|
| Prompt injection | sanitizeForPrompt(): HTML strip + 指令模式过滤 |
| 收件人篡改 | to 地址硬编码为 contact.email，LLM 不控制 |
| 内容安全 | LLM 输出检测 script/iframe 标签和异常邮箱 |
| 发送幂等 | decision_id UNIQUE 约束，发送前查重 |
| 回复去重 | msg_id 在 events 表中查重 |
| 终态保护 | TERMINAL_STATUSES 常量，多层检查 |
| 退订全局 | __global__ 记录 + 跨 campaign 状态更新 |
| Open redirect | URL 协议白名单 (http/https only) |
| Webhook 安全 | HMAC-SHA256 + timestamp 窗口 + timing-safe 比较 |
| Auth | 单租户 ADMIN_TOKEN + SHA-256 hash 比较 |
| SSRF | 私有 IP 黑名单 + 协议白名单 |
| D1 注入 | 全部参数化查询 (.bind()) |

## 11. 数据模型

```
campaigns (1)
├── campaign_contacts (N) ── email, status, intent, emails_sent
│   ├── events (N) ── event_type, event_data, created_at
│   ├── send_log (N) ── subject, body, decision_id, status
│   └── decision_log (N) ── action, reasoning, email_angle
├── tracked_links (N) ── original_url, contact_id
├── unsubscribes (N) ── email, campaign_id
└── daily_stats (N) ── date, sent_count

关键字段:
  campaigns.engine: 'sequence' | 'agent'
  campaigns.knowledge_base: JSON (LLM 产品知识)
  campaigns.status: 'draft' | 'active' | 'paused' | 'completed'
  campaign_contacts.status: 'pending' | 'active' | 'interested' |
    'converted' | 'stopped' | 'unsubscribed' | 'bounced' |
    'do_not_contact' | 'not_now' | 'not_interested' |
    'wrong_person' | 'replied' | 'error'
  events.event_type: 'email_sent' | 'link_click' | 'reply' |
    'signup' | 'payment' | 'bounce'
  send_log.decision_id: UNIQUE (幂等键)
```
