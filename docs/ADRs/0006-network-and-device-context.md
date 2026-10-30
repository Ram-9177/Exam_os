# ADR 0006 — Network addresses and device scans are context; `ipPolicy` decides what a change does

Status: Accepted · Date: 2026-10-30

## Context

Exam-day disputes often turn on two questions the platform could not answer: *from where* was the exam written, and *what was the device doing* while it was written? Until now the server kept the last address of an attempt in Redis (lost on restart) and had no record of the client's display, automation or virtualisation state. At the same time ADR 0005 forbids trusting anything the client declares, and the non-negotiables forbid any automatic penalty.

## Decision

1. **Every attempt request leaves a durable network observation.** Readiness, admission, heartbeat, save, reconnect, submit and client signals upsert `attempt_network_observations (attempt_id, ip)` with first/last seen, a counter, the first request kind and whether the address is inside the exam's `allowedSubnets`. Admission stores `admitted_ip` / `admitted_user_agent` on the attempt. Login, refresh and activation store `ip` / `user_agent` on `auth_sessions`. These rows are facts for a human, never a verdict.
2. **The exam policy `ipPolicy` decides what an in-exam address change means.**
   - `LOG` (default): an `attempt_event_log` row `network.address_changed`. Wi-Fi → hotspot is normal.
   - `REVIEW`: additionally a `NETWORK_ADDRESS_CHANGED` signal, grouped into one incident per window, for a named human to decide. Never countable.
   - `LOCK`: in-exam requests must come from `admitted_ip`. Another address is *recorded, then refused* (`409 NETWORK_ADDRESS_LOCKED`): the observation, the event and the signal commit in their own transaction before the write is rolled back. A proctor's technical hold + resume with `rebindDevice` clears `admitted_ip`; the next reconnect binds the new address. Nothing is counted and the attempt is never suspended by the server.
   - `requireManagedEndpoint` + `allowedSubnets` refuse in-exam requests from outside the lab network the same way (`NETWORK_NOT_ALLOWED`).
3. **System scans are evidence the server interprets.** The client sends only raw observations (`DeviceScan`); the server derives findings (`DEVICE_SCAN_FINDINGS`) and appends a `device_scans` row with the scan's SHA-256. At readiness a BLOCKING finding makes `SYSTEM_SCAN` `REMEDIATE`; a clean scan is recorded as `CLIENT_DECLARED` and is never a security `PASS` (a tampered client can at most hide data). During the exam a BLOCKING finding raises the mapped proctor signal (`DEVICE_SCAN_SIGNAL`) for human review; the student sees a plain-language notice saying what to fix and that the invigilator has been informed.
4. **Express trusts `loopback` outside production.** `X-Forwarded-For` from local tooling and tests is honoured; arbitrary clients cannot spoof their address. Production keeps `trust proxy = 1`.

## Consequences

- The proctor timeline and the restricted evidence PDF list every address and every scan; the raw scan JSON stays in the table.
- `LOCK` is strict by design and is meant for `SECURE_BYOD` / `MANAGED_ENDPOINT` sittings with invigilators present; `REVIEW` is the sensible default for BYOD mid-terms. The demo seeds both.
- Clean scans must never be presented as proof of a clean device, in the UI or in reports.
- One extra indexed upsert per student request; the observation table is bounded by distinct addresses per attempt, not by request count.
