# ADR 0001 — Campus = tenant, enforced by API scoping and PostgreSQL row-level security

**Status:** accepted (2026-10-30)

**Context.** Spec v3 mentioned "tenant-scoped authorization" but had no tenant model. The St. Mary's Group runs several campuses (SMRU main, Women's, Guntur) that must not see each other's data, each with its own ERP connection, exam mailbox, SSO tenant and policy baseline.

**Decision.** One deployment, many tenants. `tenants` is the root; every business table carries `tenant_id NOT NULL` and is protected by a *forced* RLS policy keyed on the transaction-local GUC `app.tenant_id`. The API connects as `examos_app` (no superuser, no BYPASSRLS, append-only privileges on evidence tables). Tenants are resolved from the Host header for users and from the API key for integrations; the token's `tid` must match. Workers that must scan across tenants set `app.bypass_tenant = 'worker'`, a documented and grep-able exception that request handlers never use (one exception: the API-key lookup, which reads one row by its unique key id before a tenant is known). Users are tenant-scoped; cross-campus staff get one user per tenant linked by the same Entra object id. Group-level reporting is read-only through group-scoped grants.

**Consequences.** Cross-tenant leakage becomes a schema error rather than a code review item (proved by `tenancy.test.ts`). Every service function takes the tenant from the request context, never from a body. Tenant creation is an admin action, not a migration.
