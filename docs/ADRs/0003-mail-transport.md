# ADR 0003 — Exam mail through a per-tenant transport, Power Automate first

**Status:** accepted (2026-10-30)

**Context.** The spec mandated Nodemailer over SMTP. Microsoft's MC786329 keeps Basic-auth SMTP submission unchanged until December 2026, disables it by default for existing tenants at the end of December 2026, and announces the final removal date in H2 2027. The university wants mail to come from a shared exam mailbox (exam@smru.edu.in) managed by IT with Power Automate.

**Decision.** A `MailTransport` abstraction over a transactional outbox (`mail_dispatches`, unique `dedupe_key`, two lanes). Transports: `power-automate` (HTTP trigger → "Send an email from a shared mailbox (V2)" → callback), `graph` (sendMail, application permission scoped by an application access policy), `smtp-oauth2` and `smtp-relay` (Nodemailer, the mandated library, without Basic auth), and `capture` (tests only, refused in production). Templates are versioned in the database and rendered by ExamOS so the audit trail stays with the dispatch. Secrets are stored as vault/`enc:` references only.

**Consequences.** IT can change the sending mechanism per tenant without a deploy. A flow outage queues, never drops. ACCEPTED is provider acceptance, not delivery. Proved by `mail.test.ts` against an emulated flow.
