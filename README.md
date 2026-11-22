# Frontdesk — Arvo Systems Support Ticket System

A production-minded support ticket system built as a hiring-test submission. Correctness of business rules is prioritized over UI polish.

## Quick Start (One Command)

```bash
docker compose up
```

This will:
1. Start PostgreSQL 16
2. Build and start the Express + React app
3. Run all migrations automatically on startup

Then open **http://localhost:3001** in your browser.

**To seed demo data after startup:**
```bash
docker compose exec app node dist/db/seed.js
```

## Demo Credentials

| Role    | Email                   | Password    |
|---------|-------------------------|-------------|
| Manager | priya@arvo.example      | manager123  |
| Agent   | anita@arvo.example      | agent123    |
| Agent   | ravi@arvo.example       | agent123    |
| Agent   | suresh@arvo.example     | agent123    |
| Agent   | deepa@arvo.example      | agent123    |
| Agent   | vikram@arvo.example     | agent123    |
| Agent   | kavya@arvo.example      | agent123    |
| Agent   | amit@arvo.example       | agent123    |
| Agent   | neha@arvo.example       | agent123    |

## Running Tests

Requires a local PostgreSQL instance:

```bash
# Start a test DB (or use docker-compose for postgres only):
docker compose up postgres -d

# Install dependencies
cd server && npm install

# Run all tests (uses TEST_DATABASE_URL)
TEST_DATABASE_URL=postgresql://frontdesk:frontdesk_dev@localhost:5432/frontdesk_test npm test
```

The test suite covers:
- `workingTime.test.ts` — All required boundary cases for `workingMinutesBetween` and `addWorkingMinutes`
- `stateMachine.test.ts` — All valid and invalid status transitions
- `tickets.test.ts` — Integration tests for INC-0291 (double-claim), INC-0304 (canary/leak), INC-0318 (immutable events)

## Architecture Overview

```
frontdesk/
├── server/                     # Node 20 + TypeScript + Express
│   ├── src/
│   │   ├── config/
│   │   │   └── constants.ts    # SLA targets, working hours, all config (ONE file)
│   │   ├── db/
│   │   │   ├── pool.ts         # pg Pool wrapper
│   │   │   ├── migrate.ts      # Idempotent migration runner
│   │   │   └── seed.ts         # Idempotent seed script
│   │   ├── domain/
│   │   │   ├── workingTime.ts  # workingMinutesBetween, addWorkingMinutes (pure, injectable)
│   │   │   ├── sla.ts          # computeSlaState, appendEvent (hash chain), due date helpers
│   │   │   └── stateMachine.ts # TRANSITION_TABLE, validateTransition
│   │   ├── middleware/
│   │   │   ├── auth.ts         # JWT (httpOnly cookie + bearer), requireAuth, requireManager
│   │   │   └── errorHandler.ts # Consistent error format
│   │   ├── routes/
│   │   │   ├── auth.ts         # POST /api/auth/login, /logout
│   │   │   ├── public.ts       # /api/public/* (rate-limited, no auth)
│   │   │   ├── tickets.ts      # /api/tickets/* (agent CRUD, claim, reply)
│   │   │   ├── manager.ts      # /api/manager/* (late report, holidays, CSV)
│   │   │   └── audit.ts        # GET /api/audit/verify (hash chain check)
│   │   ├── jobs/
│   │   │   └── sweep.ts        # In-process scheduler + idempotent sweep
│   │   └── index.ts            # App entry point
│   ├── migrations/
│   │   └── 001_init.sql        # Schema, triggers, immutability, indexes
│   └── tests/
│       ├── domain/workingTime.test.ts
│       ├── domain/stateMachine.test.ts
│       └── routes/tickets.test.ts
├── web/                        # React + Vite + TypeScript
│   └── src/
│       ├── pages/
│       │   ├── Login.tsx
│       │   ├── Dashboard.tsx   # Agent main screen (list + filters + SLA badges)
│       │   ├── TicketDetail.tsx # Thread, composer, SLA panel, timeline
│       │   ├── TrackTicket.tsx  # /track/:token (customer-facing)
│       │   └── ManagerReport.tsx # Late tickets, holidays, CSV export
│       └── api/client.ts       # Typed fetch wrapper
├── Dockerfile                  # Multi-stage: web → server → runtime
├── docker-compose.yml          # App + postgres
└── render.yaml                 # Free-tier Render deployment
```

### Database Schema

Key tables:
- **users**: id, name, email, password_hash, role (AGENT/MANAGER), is_active
- **tickets**: id, tracking_token (UUID), subject, priority, status, assignee_id, version (optimistic locking), response_due_at, resolution_due_at, first_responded_at, resolved_at, SLA outcome booleans
- **messages**: id, ticket_id, author_type, visibility (PUBLIC/INTERNAL), body
- **ticket_events**: id, ticket_id, actor, event_type, details JSONB, prev_hash, hash — append-only with DB triggers
- **holidays**: id, date (unique), name
- **customer_messages** VIEW: `SELECT * FROM messages WHERE visibility = 'PUBLIC'`

### Security Model
- DB triggers (`trg_deny_events_update`, `_delete`, `_truncate`) raise EXCEPTION on mutation of `ticket_events`
- In production, the app role `frontdesk_app` has only `SELECT, INSERT` on `ticket_events` (no UPDATE/DELETE)
- Internal note bodies are never stored in event `details` (only event type is logged)
- All customer-facing endpoints read through the `customer_messages` VIEW
- Separate serializers: agent responses include `visibility` field; customer responses never see INTERNAL messages

### SLA Mechanics
- Two clocks per ticket: **first-response** (stopped by first PUBLIC agent reply) and **resolution** (stopped by RESOLVED status)
- Both clocks paused while `status = WAITING_ON_CUSTOMER`; elapsed time computed from event log intervals
- `response_due_at` / `resolution_due_at` stored denormalized for fast sorting; set to NULL while paused
- Working time: Mon–Fri 09:30–18:30 IST, excluding holidays from the `holidays` table

---

## Assumptions & Decisions

### SLA Time Definitions
- **Same working day** = 540 working minutes (9 hours: 09:30–18:30 IST)
- **Half a day** = 270 working minutes
- **3 working days** = 1620 working minutes
- **5 working days** = 2700 working minutes

These are stored in `server/src/config/constants.ts` as the single source of truth.

### Priority Change Mid-Ticket
**Decision:** Keep already-elapsed working minutes; recompute `due_at = now + (target_minutes - elapsed)`.

**Rationale:** The spec says "do NOT restart the clock." Upgrading priority (e.g. LOW → URGENT) can make a ticket instantly late because the URGENT target may already be exceeded by the elapsed time. Downgrading gives more time by applying the new (larger) target. The first-response SLA result that already occurred is frozen and judged by the priority active at that moment.

This is logged as a `PRIORITY_CHANGED` event with old/new priority.

### Pause Rule (WAITING_ON_CUSTOMER)
When status becomes `WAITING_ON_CUSTOMER`:
- Both SLA clocks pause; `response_due_at` and `resolution_due_at` are set to NULL
- When the customer replies (or status changes back to OPEN): elapsed time is preserved, remaining time is recomputed from the event log, and new due dates are set
- Paused intervals are never counted against Arvo in the event-log reconstruction

### Reopen Window
**Decision:** 7 calendar days from `resolved_at`.

**Rationale:** The spec says "within 7 calendar days of resolution." Calendar days are simpler for customers to understand than working days, and aligns with common SaaS support practices. The window is checked by the sweep job and lazily on each request.

After the window expires, the ticket moves to CLOSED and any reopen attempt returns HTTP 409 with instructions to create a new ticket (which is linked via `parent_ticket_id`).

### Auto-Close Rule
**Decision:** 2700 working minutes (5 working days) of silence in WAITING_ON_CUSTOMER status triggers auto-close.

The sweep checks the timestamp of the last `CLOCK_PAUSED` event (which marks when the ticket entered WAITING_ON_CUSTOMER). If 2700 working minutes have elapsed since then with no `CLOCK_RESUMED` event (i.e., no customer reply), the ticket is auto-closed by SYSTEM.

### Holiday List
> ⚠️ **IMPORTANT:** The holidays seeded in `server/src/db/seed.ts` are **placeholders** for a subset of Indian public holidays in 2026. This list is **not exhaustive and not authoritative**. Arvo Systems must review and update the holidays table each year via the Manager UI or directly in the database. The seed data is only provided to demonstrate the feature.

### Clock Resumption on Reopen
When a RESOLVED ticket is reopened:
- The resolution clock resumes with the already-elapsed working minutes preserved
- New `resolution_due_at` = now + (target - already_elapsed)
- The first-response clock is already done (frozen) and not affected

### Customer Authentication
No login for customers. Each ticket has a random UUID `tracking_token` (generated by PostgreSQL's `gen_random_uuid()`). Customers bookmark or email their `/track/:token` URL. This is acceptable for a small company where tickets are created by named company contacts, not anonymous public users.

### Version Column (Optimistic Locking)
Every `UPDATE tickets` goes through `WHERE id=$1 AND version=$N`, and `version` is incremented. For the claim operation specifically, the atomic SQL `WHERE assignee_id IS NULL` is used instead (more precise than version-based locking for this use case).

---

## Deployment to Render (Free Tier)

1. Push the repository to GitHub
2. Go to [render.com](https://render.com) and create a new **Blueprint** deployment
3. Point it at your repository — Render will detect `render.yaml`
4. A free PostgreSQL instance and free web service will be provisioned
5. After first deploy, run the seed script via Render Shell:
   ```bash
   node dist/db/seed.js
   ```
6. Set environment variables in Render dashboard if needed (JWT_SECRET is auto-generated)

**Note:** Free Render instances sleep after 15 minutes of inactivity. The app handles this via lazy sweep on list/read requests, so SLA calculations catch up correctly after wake.

### Railway Alternative
Create a new project, add a PostgreSQL plugin, and set the `DATABASE_URL` environment variable. The `Dockerfile` works as-is.

---

## API Reference (brief)

### Public (no auth, rate-limited)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/public/tickets` | Create ticket (returns tracking_token) |
| GET | `/api/public/tickets/:token` | Get public ticket + messages |
| POST | `/api/public/tickets/:token/reply` | Customer reply |
| POST | `/api/public/tickets/:token/reopen` | Customer reopen (within 7 days) |

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Returns JWT (cookie + body) |
| POST | `/api/auth/logout` | Clears cookie |

### Tickets (requires auth)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tickets` | List (mine + unassigned, paginated, filterable) |
| GET | `/api/tickets/:id` | Detail with messages, events, SLA state |
| POST | `/api/tickets/:id/claim` | Atomic claim (409 if taken) |
| PATCH | `/api/tickets/:id/status` | Status transition (409 if invalid) |
| PATCH | `/api/tickets/:id/priority` | Priority change (recomputes due dates) |
| POST | `/api/tickets/:id/messages` | Post PUBLIC or INTERNAL message |

### Manager (requires MANAGER role)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/manager/late-tickets` | Late tickets report |
| GET | `/api/manager/holidays` | List holidays |
| POST | `/api/manager/holidays` | Add holiday |
| DELETE | `/api/manager/holidays/:id` | Remove holiday |
| GET | `/api/manager/export/csv` | CSV export (no internal notes) |
| GET | `/api/audit/verify` | Verify hash chain integrity |

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns `{"ok":true}` |
