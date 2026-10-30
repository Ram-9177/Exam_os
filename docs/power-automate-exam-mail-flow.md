# Exam mailbox flow — Power Automate setup guide

ExamOS sends every exam mail from the tenant's shared mailbox (for example `exam@smru.edu.in`) through a Power Automate cloud flow. ExamOS renders the mail and keeps the audit trail; the flow only sends and reports back. This keeps the mandated Nodemailer code path as a fallback without depending on Basic-auth SMTP, which Microsoft disables by default for existing tenants at the end of December 2026 (message center MC786329).

## Prerequisites (IT Head / M365 admin)

1. A **shared mailbox** per tenant: `exam@smru.edu.in` (one per campus, e.g. `exam@guntur.smru.edu.in`).
2. A **service account** (e.g. `svc-examos-mail@smru.edu.in`) with **Send As** permission on the shared mailbox. The flow is owned by this account.
3. A **Power Automate premium (per-user or per-flow) licence** on the service account — the *When an HTTP request is received* trigger is a premium connector.
4. SPF/DKIM/DMARC already in place for the sending domain (spec §4).

## Build the flow

**Trigger:** *When an HTTP request is received*

- *Who can trigger the flow?* → start with **Anyone** (URL contains its own SAS signature) while piloting; see "Hardening" below for the Entra ID option.
- Request body JSON schema:

```json
{
  "type": "object",
  "properties": {
    "dispatchId": { "type": "string" },
    "tenantId": { "type": "string" },
    "from": { "type": "string" },
    "fromName": { "type": "string" },
    "to": { "type": "string" },
    "toName": { "type": "string" },
    "subject": { "type": "string" },
    "html": { "type": "string" },
    "text": { "type": "string" },
    "category": { "type": "string" }
  },
  "required": ["dispatchId", "from", "to", "subject", "html"]
}
```

**Step 1 — Condition: shared token**
`triggerOutputs()?['headers']?['x-examos-token']` **is equal to** the tenant's flow token (store it as an environment variable or a Key Vault secret; never inline in the flow definition if the flow is exported).
If false → *Response* with status **401** and stop.

**Step 2 — Send an email from a shared mailbox (V2)** (Office 365 Outlook connector)
- Original Mailbox Address: `exam@smru.edu.in` (or `@{triggerBody()?['from']}` if the token check is per tenant)
- To: `@{triggerBody()?['to']}`
- Subject: `@{triggerBody()?['subject']}`
- Body: `@{triggerBody()?['html']}` (Is HTML: Yes)
- Importance: Normal; add a custom header is not available in this action — ExamOS tracks the dispatch by its id.

**Step 3 — Response** (inside the "true" branch, right after the send action is configured, before step 4)
- Status: **202**
- Body: `{ "dispatchId": "@{triggerBody()?['dispatchId']}", "messageId": "@{outputs('Send_an_email_from_a_shared_mailbox_(V2)')?['headers']?['x-ms-request-id']}" }`

**Step 4 — Callback to ExamOS** (HTTP action, premium)
- Method: POST
- URI: `https://<examos-host>/api/v1/integration/v1/mail/callbacks`
- Headers: `Authorization: Bearer <tenant callback secret>`, `Content-Type: application/json`
- Body on success: `{ "dispatchId": "@{triggerBody()?['dispatchId']}", "outcome": "ACCEPTED", "providerMessageId": "..." }`
- Configure *run after* so that if step 2 **fails**, a parallel branch posts `{ "dispatchId": "...", "outcome": "FAILED", "error": "@{result('Send_an_email_from_a_shared_mailbox_(V2)')[0]['error']['message']}" }`.

## Register the flow in ExamOS

`PUT /api/v1/tenant/mail-config` (tenant admin):

```json
{
  "transportKind": "power-automate",
  "senderAddress": "exam@smru.edu.in",
  "senderName": "SMRU Examination Cell",
  "endpointSecret": "<the trigger's HTTP POST URL>",
  "tokenSecret": "<the shared token the flow checks>",
  "callbackSecret": "<the bearer secret the flow sends on callback>"
}
```

Secrets are sealed with AES-256-GCM and stored as `enc:` references; they are never returned by any API.

## How ExamOS behaves

- Mail is queued in `mail_dispatches` inside the same database transaction as the business event (activation, admission, suspension alert, result published …), with a per-event `dedupe_key` so nothing is sent twice.
- The worker claims rows with `FOR UPDATE SKIP LOCKED` (several workers are safe), calls the flow, and marks the row **SENDING** on 202. The callback marks it **ACCEPTED** or **FAILED**. A dispatch with no callback for 15 minutes is retried. Flow outages back off 1 m → 5 m → 30 m → 2 h → 6 h → 24 h, then **FAILED** with the reason visible to the tenant admin.
- Two lanes: TRANSACTIONAL (activation links, receipts, alerts) never waits behind BULK (reminder waves to 1,500 students).
- ACCEPTED means the provider accepted the message, never that it reached an inbox (spec §4). Bounces arrive in the shared mailbox and are reconciled by `provider_message_id`.

## Hardening options

- **Entra ID on the trigger:** set *Who can trigger the flow?* to a specific identity and have ExamOS present a bearer token (`settings.entraBearerToken` on the mail config is passed through as `Authorization`). Microsoft documents this at learn.microsoft.com/power-automate/oauth-authentication. Whether an application (client-credentials) token is accepted in that mode must be verified in the SMRU tenant before go-live; if it is not, keep the SAS URL + shared token and restrict the flow with a trigger condition on `x-examos-token`.
- **Graph fallback:** transport `graph` with application permission `Mail.Send` **scoped to the exam mailbox** by an Exchange application access policy (`New-ApplicationAccessPolicy -AccessRight RestrictAccess -PolicyScopeGroupId <mail-enabled security group containing exam@…>`). Without the policy the app could send as any mailbox in the tenant.
- **SMTP fallback:** transport `smtp-oauth2` (Nodemailer XOAUTH2) or `smtp-relay` (IP-authenticated connector, internal recipients only). Basic-auth SMTP is deliberately not offered.
