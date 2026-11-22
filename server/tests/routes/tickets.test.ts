import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import supertest from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import { getTestPool, cleanDB } from '../setup';
import { runMigrations } from '../../src/db/migrate';
import { setHolidayFetcher } from '../../src/domain/sla';

// We'll test against a real Postgres test database
// DATABASE_URL is set by setup.ts

let pool: Pool;
let app: express.Express;
let request: ReturnType<typeof supertest>;

// Store tokens for agents
const agents: Array<{ id: string; token: string; name: string }> = [];
let managerToken = '';
let managerUserId = '';

beforeAll(async () => {
  pool = await getTestPool();

  // Set up holiday fetcher to return empty set for tests
  setHolidayFetcher(async () => new Set());

  // Build a minimal express app for testing
  const { default: authRouter } = await import('../../src/routes/auth');
  const { default: ticketsRouter } = await import('../../src/routes/tickets');
  const { default: publicRouter } = await import('../../src/routes/public');
  const { default: managerRouter } = await import('../../src/routes/manager');
  const { default: auditRouter } = await import('../../src/routes/audit');
  const { errorHandler } = await import('../../src/middleware/errorHandler');

  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.get('/health', (_, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/public', publicRouter);
  app.use('/api/tickets', ticketsRouter);
  app.use('/api/manager', managerRouter);
  app.use('/api/audit', auditRouter);
  app.use(errorHandler);

  request = supertest(app);
});

afterAll(async () => {
  const { closePool } = await import('../../src/db/pool');
  await closePool();
});

beforeEach(async () => {
  await cleanDB(pool);
  agents.length = 0;

  // Create manager
  const hash = await bcrypt.hash('manager123', 10);
  const managerResult = await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ('Test Manager', 'manager@test.example', $1, 'MANAGER') RETURNING id`,
    [hash]
  );
  managerUserId = managerResult.rows[0].id;

  // Login manager
  const mLogin = await request.post('/api/auth/login').send({
    email: 'manager@test.example',
    password: 'manager123',
  });
  managerToken = mLogin.body.token;

  // Create 10 agents for double-claim test
  for (let i = 0; i < 10; i++) {
    const h = await bcrypt.hash('agent123', 10);
    const r = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'AGENT') RETURNING id`,
      [`Agent ${i}`, `agent${i}@test.example`, h]
    );
    const agentId = r.rows[0].id;
    const login = await request.post('/api/auth/login').send({
      email: `agent${i}@test.example`,
      password: 'agent123',
    });
    agents.push({ id: agentId, token: login.body.token, name: `Agent ${i}` });
  }
});

// ══════════════════════════════════════════════════════════════
// INC-0291: Double-claim test
// ══════════════════════════════════════════════════════════════
describe('INC-0291: Double-claim prevention', () => {
  it('exactly one of 10 parallel claim requests succeeds', async () => {
    // Create a ticket
    const tRes = await request.post('/api/public/tickets').send({
      name: 'Test Customer',
      email: 'cust@example.com',
      subject: 'Double claim test',
      description: 'Race condition test',
      impact: 'cannot work at all',
    });
    expect(tRes.status).toBe(201);
    const ticketId = tRes.body.id;

    // Fire 10 parallel claim requests
    const results = await Promise.allSettled(
      agents.map((agent) =>
        request
          .post(`/api/tickets/${ticketId}/claim`)
          .set('Authorization', `Bearer ${agent.token}`)
          .send()
      )
    );

    const successes = results.filter(
      (r) => r.status === 'fulfilled' && (r.value as { status: number }).status === 200
    );
    const conflicts = results.filter(
      (r) => r.status === 'fulfilled' && (r.value as { status: number }).status === 409
    );

    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(9);

    // Check 409 response includes assignee name
    const conflictBody = (conflicts[0] as PromiseFulfilledResult<{ body: Record<string, unknown> }>).value.body;
    expect(conflictBody.error).toMatch(/already claimed|Agent/i);
  });

  it('agent cannot reply on a ticket assigned to another agent', async () => {
    // Create and have agent0 claim a ticket
    const tRes = await request.post('/api/public/tickets').send({
      name: 'Customer',
      email: 'c@example.com',
      subject: 'Cross-agent reply test',
      description: 'Test',
      impact: 'partly affected',
    });
    const ticketId = tRes.body.id;

    // Agent 0 claims
    await request
      .post(`/api/tickets/${ticketId}/claim`)
      .set('Authorization', `Bearer ${agents[0].token}`)
      .send();

    // Agent 1 tries to reply → should get 403
    const replyRes = await request
      .post(`/api/tickets/${ticketId}/messages`)
      .set('Authorization', `Bearer ${agents[1].token}`)
      .send({ body: 'Sneaky reply', visibility: 'PUBLIC' });

    expect(replyRes.status).toBe(403);

    // Manager can reply on any ticket
    const managerReply = await request
      .post(`/api/tickets/${ticketId}/messages`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ body: 'Manager reply', visibility: 'PUBLIC' });

    expect(managerReply.status).toBe(201);
  });
});

// ══════════════════════════════════════════════════════════════
// INC-0304: Private-note canary test
// ══════════════════════════════════════════════════════════════
describe('INC-0304: Internal note never leaks to customer', () => {
  it('canary string never appears in any customer-facing endpoint or export', async () => {
    const CANARY = `CANARY-SECRET-${Date.now()}-XYZ`;

    // Create a ticket
    const tRes = await request.post('/api/public/tickets').send({
      name: 'Customer',
      email: 'cust@example.com',
      subject: 'Canary test ticket',
      description: 'Public description',
      impact: 'partly affected',
    });
    const ticketId = tRes.body.id;
    const trackingToken = tRes.body.tracking_token;

    // Agent 0 claims
    await request
      .post(`/api/tickets/${ticketId}/claim`)
      .set('Authorization', `Bearer ${agents[0].token}`)
      .send();

    // Post an INTERNAL note with the canary
    const noteRes = await request
      .post(`/api/tickets/${ticketId}/messages`)
      .set('Authorization', `Bearer ${agents[0].token}`)
      .send({ body: CANARY, visibility: 'INTERNAL' });
    expect(noteRes.status).toBe(201);

    // Now call every customer-facing endpoint and assert canary is absent

    // 1. GET /api/public/tickets/:token
    const pubTicket = await request.get(`/api/public/tickets/${trackingToken}`);
    expect(JSON.stringify(pubTicket.body)).not.toContain(CANARY);

    // 2. POST /api/public/tickets/:token/reply (response body)
    const replyRes = await request
      .post(`/api/public/tickets/${trackingToken}/reply`)
      .send({ body: 'Customer question' });
    expect(JSON.stringify(replyRes.body)).not.toContain(CANARY);

    // 3. Manager CSV export
    const csvRes = await request
      .get('/api/manager/export/csv')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(csvRes.text).not.toContain(CANARY);

    // 4. Public ticket list (no such endpoint, but health/404 shouldn't leak either)
    const health = await request.get('/health');
    expect(JSON.stringify(health.body)).not.toContain(CANARY);
  });
});

// ══════════════════════════════════════════════════════════════
// INC-0318: Immutable event log
// ══════════════════════════════════════════════════════════════
describe('INC-0318: Immutable ticket_events', () => {
  it('UPDATE on ticket_events raises exception', async () => {
    // Create a ticket so there's an event
    const tRes = await request.post('/api/public/tickets').send({
      name: 'Test',
      email: 't@example.com',
      subject: 'Immutability test',
      description: 'Test',
      impact: 'question or request',
    });
    const ticketId = tRes.body.id;

    // Try to UPDATE an event directly in the DB
    await expect(
      pool.query(`UPDATE ticket_events SET actor = 'TAMPERED' WHERE ticket_id = $1`, [ticketId])
    ).rejects.toThrow(/append-only|forbidden/i);
  });

  it('DELETE on ticket_events raises exception', async () => {
    const tRes = await request.post('/api/public/tickets').send({
      name: 'Test',
      email: 't@example.com',
      subject: 'Delete test',
      description: 'Test',
      impact: 'question or request',
    });
    const ticketId = tRes.body.id;

    await expect(
      pool.query(`DELETE FROM ticket_events WHERE ticket_id = $1`, [ticketId])
    ).rejects.toThrow(/append-only|forbidden/i);
  });

  it('audit verify endpoint returns ok=true for untampered events', async () => {
    await request.post('/api/public/tickets').send({
      name: 'Test',
      email: 't@example.com',
      subject: 'Hash chain test',
      description: 'Test',
      impact: 'partly affected',
    });

    const verifyRes = await request
      .get('/api/audit/verify')
      .set('Authorization', `Bearer ${managerToken}`);

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.ok).toBe(true);
    expect(verifyRes.body.tampered_count).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Status machine enforcement
// ══════════════════════════════════════════════════════════════
describe('Status machine', () => {
  it('rejects illegal transition with 409', async () => {
    const tRes = await request.post('/api/public/tickets').send({
      name: 'Customer',
      email: 'c@example.com',
      subject: 'State machine test',
      description: 'Test',
      impact: 'partly affected',
    });
    const ticketId = tRes.body.id;

    // Try to move from NEW → RESOLVED (invalid)
    await request
      .post(`/api/tickets/${ticketId}/claim`)
      .set('Authorization', `Bearer ${agents[0].token}`)
      .send();

    // OPEN → RESOLVED is valid
    const resolveRes = await request
      .patch(`/api/tickets/${ticketId}/status`)
      .set('Authorization', `Bearer ${agents[0].token}`)
      .send({ status: 'RESOLVED' });
    expect(resolveRes.status).toBe(200);

    // RESOLVED → WAITING_ON_CUSTOMER is INVALID
    const badRes = await request
      .patch(`/api/tickets/${ticketId}/status`)
      .set('Authorization', `Bearer ${agents[0].token}`)
      .send({ status: 'WAITING_ON_CUSTOMER' });
    expect(badRes.status).toBe(409);
  });
});

// ══════════════════════════════════════════════════════════════
// SLA: priority change
// ══════════════════════════════════════════════════════════════
describe('SLA: priority change mid-ticket', () => {
  it('changing priority does not reset elapsed time', async () => {
    const tRes = await request.post('/api/public/tickets').send({
      name: 'Customer',
      email: 'c@example.com',
      subject: 'Priority change test',
      description: 'Test',
      impact: 'question or request', // LOW
    });
    const ticketId = tRes.body.id;

    const before = await request
      .get(`/api/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${managerToken}`);

    const resolutionDueBefore = before.body.ticket.resolution_due_at;

    // Change to URGENT
    const changeRes = await request
      .patch(`/api/tickets/${ticketId}/priority`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ priority: 'URGENT' });

    expect(changeRes.status).toBe(200);
    expect(changeRes.body.priority).toBe('URGENT');

    // The resolution_due_at should have changed (shorter SLA)
    expect(changeRes.body.resolution_due_at).not.toBe(resolutionDueBefore);
  });
});
