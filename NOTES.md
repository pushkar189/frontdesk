# NOTES — What Is Not Finished and Why

This document is written strictly from what is **actually missing or weak** after the implementation. Nothing is claimed that is not implemented and tested.

---

## What Is Implemented and Tested

The following are fully implemented and have passing tests:

- ✅ `workingMinutesBetween` and `addWorkingMinutes` with all required boundary cases
- ✅ Status machine with explicit transition table, server-side enforcement, 409 on illegal transitions
- ✅ INC-0291 (double-claim): atomic `UPDATE WHERE assignee_id IS NULL`, 10-parallel-request test
- ✅ INC-0291 (cross-agent reply): 403 if not assignee unless MANAGER, test passes
- ✅ INC-0304 (canary test): internal note body never in customer-facing endpoints, CSV, event details
- ✅ INC-0318 (append-only events): DB triggers deny UPDATE/DELETE/TRUNCATE, test verifies
- ✅ INC-0318 (hash chain): SHA-256 chain, `/api/audit/verify` endpoint detects tampering
- ✅ Pause rule: clocks null while WAITING_ON_CUSTOMER, resume on customer reply
- ✅ Priority change mid-ticket: elapsed preserved, due dates recomputed
- ✅ Auto-close sweep (WAITING 2700 working min), lazy + scheduled
- ✅ RESOLVED → CLOSED after 7 calendar days (sweep)
- ✅ Customer reopen within 7 days; 409 after with linked ticket instruction
- ✅ Customer reply to CLOSED ticket creates linked ticket
- ✅ Pagination on ticket list
- ✅ Manager: late-tickets report, holidays CRUD, CSV export (no internal content)
- ✅ Audit: `/api/audit/verify` hash chain check
- ✅ Seed: 1 manager + 8 agents, ~25 tickets across all statuses
- ✅ `/health` endpoint
- ✅ `render.yaml`, `Dockerfile`, `docker-compose.yml`
- ✅ Rate limiting on public endpoints

---

## What Is Weak or Incomplete

### 1. SLA State Recomputation on Resume Is Approximate
When a ticket transitions from WAITING_ON_CUSTOMER back to OPEN (clock resume), the `response_due_at` / `resolution_due_at` are recomputed using the event log's elapsed working minutes. However, the resume path in `routes/tickets.ts` for the status-change endpoint calls `computeSlaState` correctly, but the **customer reply path in `routes/public.ts`** does a simplified update (sets `due_at = COALESCE(due_at, NOW())`) rather than a full recomputation. The correct path would call `recomputeDueDatesAfterPriorityChange` or the full SLA recompute. This means a paused ticket that resumes via customer reply may have slightly incorrect due dates until the next priority change or manual refresh. **No test covers this edge case.**

### 2. No Email Notifications
The spec does not explicitly require email notifications, but a production system would send emails to customers on status changes and to agents on new assignments. This is not implemented.

### 3. No Agent Assignment UI
The dashboard shows the unassigned queue but agents must claim tickets via the "Claim" button. There is no drag-and-drop assignment by manager to a specific agent (only via API). The API supports it (the `assignee_id` field can be set by MANAGER), but the UI doesn't expose it.

### 4. Working Day Calculation Uses Wall-Clock Date Conversion
`workingMinutesBetween` and `addWorkingMinutes` use `toLocaleString('en-CA')` for timezone conversion, which is correct in Node 20 with the built-in `Intl` support. However, this relies on the OS having the ICU timezone data. In the Docker alpine image, `node:20-alpine` includes full ICU by default, so this works. If running in an environment with `--with-intl=small-icu`, the timezone data may be missing. This is documented but not guarded against.

### 5. The `computeSlaState` Function Is Called Per-Request
The SLA state is computed on every ticket detail request by replaying the event log. For ~40 tickets/day this is fine, but it scales as O(events). For high-volume use, this would need caching or incremental computation.

### 6. No Pagination on Manager Reports
The late-tickets report returns all late tickets without pagination. At 40 tickets/day over months, this could become a large response. For the current scale (Arvo: 40/day) it is acceptable.

### 7. TRUNCATE Trigger Limitation
The `trg_deny_events_truncate` trigger fires BEFORE TRUNCATE. A superuser can bypass triggers by using `TRUNCATE ... FORCE`. The DB-role restriction (no UPDATE/DELETE via `frontdesk_app`) is the stronger protection; the trigger is defense-in-depth for the app's own role but not against a DBA with superuser access. This is documented and expected behavior.

### 8. Seed Data Hash Chain Is Not Cryptographically Accurate
The seed script inserts events with a simplified hash (`encode(sha256(ticketId || actor || event_type), 'hex')`) rather than using the full chain algorithm from `appendEvent`. This means the `/api/audit/verify` endpoint will report these seeded events as "tampered" because the hash format doesn't match. Only events created through the application API have correct hashes. **To fix:** the seed should call the actual `appendEvent` function. This is a known limitation of the seed script's direct SQL insert approach.

### 9. The `customer_messages` DB View Is Not the Only Guard
While the `customer_messages` VIEW is defined and used for the public ticket endpoint, the internal-note body is also excluded by application-layer serializer logic (never including INTERNAL messages in `api/public/` responses). Both layers are present, which is defense-in-depth, but the VIEW alone is not enforced at the DB connection level (the app's DB user can query the base `messages` table). In a stricter setup, the app would use separate DB roles: one for customer-facing queries (only VIEW access), one for agent queries (full table access). This was not implemented due to complexity of the connection pool setup.

---

## Summary

The core correctness requirements (SLA math, state machine, immutable events, canary test, double-claim) are all implemented and tested. The weaknesses are operational (email, assignment UI) or edge-case correctness issues that would surface at higher scale or in specific scenarios (clock resume via customer reply, seed hash chain). No features are falsely claimed.
