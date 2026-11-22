import { Router, Response, NextFunction, Request } from 'express';
import { z } from 'zod';
import { withTransaction, query, queryOne } from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { validateTransition } from '../domain/stateMachine';
import { Priority, SLA_TARGETS, WORKING_HOURS, DUE_SOON_THRESHOLD_MINUTES } from '../config/constants';
import {
  computeInitialDueDates,
  computeSlaState,
  recomputeDueDatesAfterPriorityChange,
  appendEvent,
} from '../domain/sla';
import { addWorkingMinutes } from '../domain/workingTime';
import { runSweep } from '../jobs/sweep';



const router = Router();

// All ticket routes require auth
router.use(requireAuth);

// ── List tickets ──────────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // Run lazy sweep
    runSweep().catch(console.error);

    const { status, priority, page = '1', pageSize = '25', view = 'mine' } = req.query as Record<string, string>;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);
    const limit = Math.min(parseInt(pageSize), 100);

    const userId = req.user!.sub;
    const isManager = req.user!.role === 'MANAGER';

    let conditions: string[] = [];
    let params: unknown[] = [];
    let idx = 1;

    // Filter: 'mine' = assigned to me OR unassigned; 'all' = all (manager only)
    if (view === 'mine' || !isManager) {
      conditions.push(`(assignee_id = $${idx} OR (assignee_id IS NULL AND status = 'NEW'))`);
      params.push(userId);
      idx++;
    }

    if (status) {
      conditions.push(`status = $${idx}::ticket_status`);
      params.push(status);
      idx++;
    }

    if (priority) {
      conditions.push(`priority = $${idx}::ticket_priority`);
      params.push(priority);
      idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const now = new Date().toISOString();

    // Compute is_late and is_due_soon in SQL for sorting
    const sql = `
      SELECT
        t.*,
        u.name AS assignee_name,
        CASE
          WHEN t.response_due_at IS NOT NULL AND t.first_responded_at IS NULL
               AND NOW() > t.response_due_at THEN true
          WHEN t.resolution_due_at IS NOT NULL AND t.resolved_at IS NULL
               AND NOW() > t.resolution_due_at THEN true
          ELSE false
        END AS is_late,
        CASE
          WHEN t.response_due_at IS NOT NULL AND t.first_responded_at IS NULL
               AND t.response_due_at > NOW()
               AND EXTRACT(EPOCH FROM (t.response_due_at - NOW())) / 60 < 30 THEN true
          WHEN t.resolution_due_at IS NOT NULL AND t.resolved_at IS NULL
               AND t.resolution_due_at > NOW()
               AND EXTRACT(EPOCH FROM (t.resolution_due_at - NOW())) / 60 < 30 THEN true
          ELSE false
        END AS is_due_soon,
        COUNT(*) OVER() AS total_count
      FROM tickets t
      LEFT JOIN users u ON t.assignee_id = u.id
      ${where}
      ORDER BY
        is_late DESC,
        CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
        t.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    params.push(limit, offset);

    const rows = await query<Record<string, unknown>>(sql, params);
    const total = rows.length > 0 ? parseInt(rows[0].total_count as string) : 0;

    res.json({
      tickets: rows.map(r => {
        const { total_count, ...rest } = r;
        return rest;
      }),
      pagination: { page: parseInt(page), pageSize: limit, total },
    });
  } catch (err) {
    next(err);
  }
});

// ── Get ticket detail ─────────────────────────────────────────
router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    runSweep().catch(console.error);

    const id = req.params.id as string;
    const ticket = await queryOne<Record<string, unknown>>(
      `SELECT t.*, u.name AS assignee_name
       FROM tickets t
       LEFT JOIN users u ON t.assignee_id = u.id
       WHERE t.id = $1`,
      [id]
    );

    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    // All messages (PUBLIC + INTERNAL) for agents
    const messages = await query<Record<string, unknown>>(
      `SELECT m.*, u.name AS author_name
       FROM messages m
       LEFT JOIN users u ON m.author_id = u.id
       WHERE m.ticket_id = $1
       ORDER BY m.created_at ASC`,
      [id]
    );

    // Events (PUBLIC event types shown — internal note body is never in details)
    const events = await query<Record<string, unknown>>(
      `SELECT te.*, u.name AS actor_name
       FROM ticket_events te
       LEFT JOIN users u ON te.actor::text = u.id::text
       WHERE te.ticket_id = $1
       ORDER BY te.id ASC`,
      [id]
    );

    // SLA state
    const slaState = await computeSlaState(id);

    res.json({ ticket, messages, events, slaState });
  } catch (err) {
    next(err);
  }
});

// ── Claim ticket (atomic, INC-0291) ─────────────────────────
router.post('/:id/claim', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const agentId = req.user!.sub;

    const result = await withTransaction(async (client) => {
      // Atomic claim: only succeeds if unassigned
      const updated = await client.query(
        `UPDATE tickets
         SET assignee_id = $1, status = 'OPEN', version = version + 1
         WHERE id = $2 AND assignee_id IS NULL AND status = 'NEW'
         RETURNING *`,
        [agentId, id]
      );

      if (updated.rows.length === 0) {
        // Check who has it
        const current = await client.query(
          `SELECT t.assignee_id, u.name AS assignee_name, t.status
           FROM tickets t LEFT JOIN users u ON t.assignee_id = u.id
           WHERE t.id = $1`,
          [id]
        );
        const cur = current.rows[0] as { assignee_id: string | null; assignee_name: string | null; status: string } | undefined;

        const err: Error & { status?: number; code?: string; details?: unknown } = new Error(
          cur?.assignee_id
            ? `Ticket already claimed by ${cur.assignee_name ?? 'another agent'}`
            : `Ticket cannot be claimed (status: ${cur?.status ?? 'unknown'})`
        );
        err.status = 409;
        err.code = 'ALREADY_CLAIMED';
        err.details = { assignee_name: cur?.assignee_name };
        throw err;
      }

      const ticket = updated.rows[0] as Record<string, unknown>;
      await appendEvent(client as Parameters<typeof appendEvent>[0], id, agentId, 'TICKET_CLAIMED', {
        assignee: agentId,
      });
      await appendEvent(client as Parameters<typeof appendEvent>[0], id, agentId, 'STATUS_CHANGED', {
        from: 'NEW', to: 'OPEN',
      });

      return ticket;
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Status transition ─────────────────────────────────────────
router.patch('/:id/status', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const StatusSchema = z.object({ status: z.enum(['OPEN', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED']) });
    const { status: newStatus } = StatusSchema.parse(req.body);

    const ticket = await queryOne<{
      id: string; status: string; assignee_id: string | null; version: number; priority: string;
    }>(
      `SELECT id, status, assignee_id, version, priority FROM tickets WHERE id = $1`,
      [id]
    );
    if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }

    const actor = req.user!;
    // Only assignee or MANAGER can change status
    if (ticket.assignee_id !== actor.sub && actor.role !== 'MANAGER') {
      res.status(403).json({ error: 'You can only manage tickets assigned to you' });
      return;
    }

    validateTransition(ticket.status as 'NEW' | 'OPEN' | 'WAITING_ON_CUSTOMER' | 'RESOLVED' | 'CLOSED', newStatus as 'OPEN' | 'WAITING_ON_CUSTOMER' | 'RESOLVED' | 'CLOSED');

    await withTransaction(async (client) => {
      const now = new Date();
      const updates: Record<string, unknown> = {
        status: newStatus,
        version: ticket.version + 1,
      };

      let extraEvents: Array<[string, Record<string, unknown>]> = [];

      if (newStatus === 'WAITING_ON_CUSTOMER') {
        updates.response_due_at = null;
        updates.resolution_due_at = null;
        extraEvents.push(['CLOCK_PAUSED', { reason: 'waiting_on_customer' }]);
      } else if (newStatus === 'OPEN' && ticket.status === 'WAITING_ON_CUSTOMER') {
        // Resuming — recompute due dates
        const slaState = await computeSlaState(id, now);
        const target = SLA_TARGETS[ticket.priority as Priority];
        const holidays = await (await import('../domain/sla')).getHolidaysFromDB();
        const getHols = async () => holidays;

        if (!slaState.isFirstResponseDone) {
          const remaining = Math.max(0, target.firstReplyMinutes - slaState.firstResponseElapsedMinutes);
          updates.response_due_at = (await addWorkingMinutes(now, remaining, WORKING_HOURS, getHols)).toISOString();
        }
        const remaining = Math.max(0, target.resolutionMinutes - slaState.resolutionElapsedMinutes);
        updates.resolution_due_at = (await addWorkingMinutes(now, remaining, WORKING_HOURS, getHols)).toISOString();
        extraEvents.push(['CLOCK_RESUMED', {}]);
      } else if (newStatus === 'RESOLVED') {
        const slaState = await computeSlaState(id, now);
        const target = SLA_TARGETS[ticket.priority as Priority];
        const met = slaState.resolutionElapsedMinutes <= target.resolutionMinutes;
        updates.resolved_at = now.toISOString();
        updates.resolution_sla_met = met;
      }

      // Build SET clause
      const setClause = Object.keys(updates)
        .filter(k => k !== 'version')
        .map((k, i) => `${k} = $${i + 2}`)
        .join(', ') + `, version = $${Object.keys(updates).length + 1}`;

      const vals = [id, ...Object.values(updates).filter((_, i) => Object.keys(updates)[i] !== 'version'), ticket.version + 1];

      // Simpler: just update directly
      await client.query(
        `UPDATE tickets SET status = $1, version = version + 1,
           response_due_at = $2, resolution_due_at = $3,
           resolved_at = $4, resolution_sla_met = $5
         WHERE id = $6 AND version = $7`,
        [
          newStatus,
          updates.response_due_at ?? null,
          updates.resolution_due_at ?? null,
          updates.resolved_at ?? null,
          updates.resolution_sla_met ?? null,
          id,
          ticket.version,
        ]
      );

      for (const [evType, evDetails] of extraEvents) {
        await appendEvent(client as Parameters<typeof appendEvent>[0], id, actor.sub, evType as 'CLOCK_PAUSED' | 'CLOCK_RESUMED', evDetails);
      }

      await appendEvent(client as Parameters<typeof appendEvent>[0], id, actor.sub, 'STATUS_CHANGED', {
        from: ticket.status, to: newStatus,
      });
    });

    const updated = await queryOne<Record<string, unknown>>(`SELECT * FROM tickets WHERE id = $1`, [id]);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── Priority change ───────────────────────────────────────────
router.patch('/:id/priority', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const Schema = z.object({ priority: z.enum(['URGENT', 'MEDIUM', 'LOW']) });
    const { priority: newPriority } = Schema.parse(req.body);

    const ticket = await queryOne<{ id: string; priority: string; status: string; version: number; assignee_id: string | null }>(
      `SELECT id, priority, status, version, assignee_id FROM tickets WHERE id = $1`,
      [id]
    );
    if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }

    const actor = req.user!;
    if (ticket.assignee_id !== actor.sub && actor.role !== 'MANAGER') {
      res.status(403).json({ error: 'You can only manage tickets assigned to you' });
      return;
    }

    const now = new Date();
    const { responseDueAt, resolutionDueAt } = await recomputeDueDatesAfterPriorityChange(id, newPriority as Priority, now);

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE tickets
         SET priority = $1, response_due_at = $2, resolution_due_at = $3, version = version + 1
         WHERE id = $4 AND version = $5`,
        [newPriority, responseDueAt?.toISOString() ?? null, resolutionDueAt?.toISOString() ?? null, id, ticket.version]
      );

      await appendEvent(client as Parameters<typeof appendEvent>[0], id, actor.sub, 'PRIORITY_CHANGED', {
        from: ticket.priority, to: newPriority,
      });
    });

    const updated = await queryOne<Record<string, unknown>>(`SELECT * FROM tickets WHERE id = $1`, [id]);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── Post message ──────────────────────────────────────────────
router.post('/:id/messages', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const Schema = z.object({
      body: z.string().min(1).max(10000),
      visibility: z.enum(['PUBLIC', 'INTERNAL']),
    });
    const { body: msgBody, visibility } = Schema.parse(req.body);

    const ticket = await queryOne<{ id: string; status: string; assignee_id: string | null; first_responded_at: Date | null; priority: string; version: number }>(
      `SELECT id, status, assignee_id, first_responded_at, priority, version FROM tickets WHERE id = $1`,
      [id]
    );
    if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }

    const actor = req.user!;
    // Agents can only reply to their own ticket unless MANAGER (INC-0291)
    if (ticket.assignee_id && ticket.assignee_id !== actor.sub && actor.role !== 'MANAGER') {
      res.status(403).json({ error: 'You can only post on tickets assigned to you' });
      return;
    }

    if (['CLOSED', 'RESOLVED'].includes(ticket.status) && visibility === 'PUBLIC') {
      res.status(409).json({ error: 'Cannot post public reply on a closed/resolved ticket' });
      return;
    }

    const now = new Date();

    await withTransaction(async (client) => {
      // Insert message
      const msgResult = await client.query(
        `INSERT INTO messages (ticket_id, author_type, author_id, visibility, body)
         VALUES ($1, 'AGENT', $2, $3, $4) RETURNING *`,
        [id, actor.sub, visibility, msgBody]
      );
      const msg = (msgResult.rows as Record<string, unknown>[])[0];

      if (visibility === 'INTERNAL') {
        // Log INTERNAL_NOTE event — body is NOT stored in event details (INC-0304)
        await appendEvent(client as Parameters<typeof appendEvent>[0], id, actor.sub, 'INTERNAL_NOTE', {});
      } else {
        // PUBLIC_REPLY
        await appendEvent(client as Parameters<typeof appendEvent>[0], id, actor.sub, 'PUBLIC_REPLY', {
          preview: msgBody.substring(0, 100),
        });

        // First public agent reply — stop first-response clock
        if (!ticket.first_responded_at) {
          const slaState = await computeSlaState(id, now);
          const target = SLA_TARGETS[ticket.priority as Priority];
          const met = slaState.firstResponseElapsedMinutes <= target.firstReplyMinutes;

          await client.query(
            `UPDATE tickets
             SET first_responded_at = $1, first_response_sla_met = $2,
                 response_due_at = NULL, version = version + 1
             WHERE id = $3`,
            [now.toISOString(), met, id]
          );
        }
      }
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Get all agents (for assignment UI) ───────────────────────
router.get('/agents/list', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const agents = await query<{ id: string; name: string; email: string; role: string }>(
      `SELECT id, name, email, role FROM users WHERE is_active = true ORDER BY name`
    );
    res.json(agents);
  } catch (err) {
    next(err);
  }
});

export default router;
