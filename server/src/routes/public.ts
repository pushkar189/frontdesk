import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { withTransaction, query, queryOne } from '../db/pool';
import { IMPACT_TO_PRIORITY, Priority } from '../config/constants';
import { computeInitialDueDates } from '../domain/sla';
import { appendEvent } from '../domain/sla';

const router = Router();

// Rate limit: 20 requests per 15 minutes per IP
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const CreateTicketSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  subject: z.string().min(1).max(500),
  description: z.string().min(1).max(10000),
  impact: z.enum(['cannot work at all', 'partly affected', 'question or request']),
});

// POST /api/public/tickets — create a ticket (no auth, rate limited)
router.post('/tickets', publicLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = CreateTicketSchema.parse(req.body);
    const priority = IMPACT_TO_PRIORITY[body.impact] as Priority;

    const ticket = await withTransaction(async (client) => {
      // Create ticket
      const result = await client.query(
        `INSERT INTO tickets
           (subject, description, customer_name, customer_email, priority, status)
         VALUES ($1, $2, $3, $4, $5, 'NEW')
         RETURNING *`,
        [body.subject, body.description, body.name, body.email, priority]
      );
      const t = (result.rows as Record<string, unknown>[])[0];

      // Compute initial SLA due dates
      const { responseDueAt, resolutionDueAt } = await computeInitialDueDates(
        new Date(t.created_at as string),
        priority
      );

      await client.query(
        `UPDATE tickets SET response_due_at = $1, resolution_due_at = $2 WHERE id = $3`,
        [responseDueAt.toISOString(), resolutionDueAt.toISOString(), t.id]
      );

      // Log event
      await appendEvent(client as Parameters<typeof appendEvent>[0], t.id as string, 'CUSTOMER', 'TICKET_CREATED', {
        subject: t.subject,
        priority,
      });

      return { ...(t as Record<string, unknown>), response_due_at: responseDueAt, resolution_due_at: resolutionDueAt } as Record<string, unknown>;
    });

    res.status(201).json({
      id: ticket['id'],
      tracking_token: ticket['tracking_token'],
      subject: ticket['subject'],
      priority: ticket['priority'],
      status: ticket['status'],
      created_at: ticket['created_at'],
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/public/tickets/:token — get public ticket view (no internal notes)
router.get('/tickets/:token', publicLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;

    const ticket = await queryOne<Record<string, unknown>>(
      `SELECT id, tracking_token, subject, description, customer_name, customer_email,
              priority, status, response_due_at, resolution_due_at,
              first_responded_at, first_response_sla_met,
              resolved_at, resolution_sla_met,
              created_at, updated_at, parent_ticket_id
       FROM tickets WHERE tracking_token = $1`,
      [token]
    );

    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    // Public messages only — via customer_messages view
    const messages = await query<Record<string, unknown>>(
      `SELECT cm.id, cm.ticket_id, cm.author_type,
              u.name AS author_name,
              cm.body, cm.created_at
       FROM customer_messages cm
       LEFT JOIN users u ON cm.author_id = u.id
       WHERE cm.ticket_id = $1
       ORDER BY cm.created_at ASC`,
      [ticket.id as string]
    );

    res.json({ ticket, messages });
  } catch (err) {
    next(err);
  }
});

// POST /api/public/tickets/:token/reply — customer replies
router.post('/tickets/:token/reply', publicLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;
    const ReplySchema = z.object({ body: z.string().min(1).max(10000) });
    const { body: msgBody } = ReplySchema.parse(req.body);

    const ticket = await queryOne<{
      id: string;
      status: string;
      tracking_token: string;
      subject: string;
    }>(
      `SELECT id, status, tracking_token, subject FROM tickets WHERE tracking_token = $1`,
      [token]
    );

    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    if (ticket.status === 'CLOSED') {
      // Create a new linked ticket
      const newTicket = await withTransaction(async (client) => {
        const tRow = await queryOne<Record<string, unknown>>(
          `SELECT * FROM tickets WHERE id = $1`,
          [ticket.id]
        );
        const result = await client.query(
          `INSERT INTO tickets
             (subject, description, customer_name, customer_email, priority, status, parent_ticket_id)
           SELECT subject, $1, customer_name, customer_email, priority, 'NEW', $2
           FROM tickets WHERE id = $3
           RETURNING *`,
          [`[Re: ${ticket.subject}] - Customer reply after closure`, ticket.id, ticket.id]
        );
        const newT = (result.rows as Record<string, unknown>[])[0];

        const { responseDueAt, resolutionDueAt } = await computeInitialDueDates(
          new Date(newT.created_at as string),
          newT.priority as Priority
        );
        await client.query(
          `UPDATE tickets SET response_due_at = $1, resolution_due_at = $2 WHERE id = $3`,
          [responseDueAt.toISOString(), resolutionDueAt.toISOString(), newT.id]
        );

        await client.query(
          `INSERT INTO messages (ticket_id, author_type, visibility, body) VALUES ($1, 'CUSTOMER', 'PUBLIC', $2)`,
          [newT.id, msgBody]
        );

        await appendEvent(client as Parameters<typeof appendEvent>[0], newT.id as string, 'CUSTOMER', 'TICKET_CREATED', {
          subject: newT.subject, linkedFrom: ticket.id,
        });

        return newT;
      });

      res.status(201).json({
        message: 'Your ticket is closed. A new linked ticket has been created.',
        tracking_token: newTicket.tracking_token,
      });
      return;
    }

    // Normal reply
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO messages (ticket_id, author_type, visibility, body) VALUES ($1, 'CUSTOMER', 'PUBLIC', $2)`,
        [ticket.id, msgBody]
      );

      await appendEvent(client as Parameters<typeof appendEvent>[0], ticket.id, 'CUSTOMER', 'PUBLIC_REPLY', {
        preview: msgBody.substring(0, 100),
      });

      // If WAITING_ON_CUSTOMER → resume clocks (transition to OPEN)
      if (ticket.status === 'WAITING_ON_CUSTOMER') {
        await appendEvent(client as Parameters<typeof appendEvent>[0], ticket.id, 'CUSTOMER', 'CLOCK_RESUMED', {});
        await appendEvent(client as Parameters<typeof appendEvent>[0], ticket.id, 'CUSTOMER', 'STATUS_CHANGED', {
          from: 'WAITING_ON_CUSTOMER', to: 'OPEN',
        });

        // Recompute due dates from current elapsed
        const tFull = await queryOne<{ priority: string; created_at: Date; response_due_at: Date }>(
          `SELECT priority, created_at, response_due_at FROM tickets WHERE id = $1`,
          [ticket.id]
        );
        // We'll set due dates: add remaining minutes to now
        // For simplicity, resume means set due = now + remaining
        // The slaService will recompute properly; here we just un-pause
        await client.query(
          `UPDATE tickets
           SET status = 'OPEN', version = version + 1,
               response_due_at = COALESCE(response_due_at, NOW()),
               resolution_due_at = COALESCE(resolution_due_at, NOW())
           WHERE id = $1`,
          [ticket.id]
        );
      }
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/public/tickets/:token/reopen — customer reopens
router.post('/tickets/:token/reopen', publicLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;
    const ticket = await queryOne<{
      id: string;
      status: string;
      resolved_at: Date;
      priority: string;
    }>(
      `SELECT id, status, resolved_at, priority FROM tickets WHERE tracking_token = $1`,
      [token]
    );

    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    if (ticket.status !== 'RESOLVED') {
      res.status(409).json({ error: 'Ticket is not in RESOLVED status' });
      return;
    }

    // Check 7-day window
    const resolvedAt = new Date(ticket.resolved_at);
    const now = new Date();
    const daysDiff = (now.getTime() - resolvedAt.getTime()) / (1000 * 60 * 60 * 24);

    if (daysDiff > 7) {
      res.status(409).json({
        error: 'Reopen window has passed (7 calendar days). Please create a new ticket.',
        code: 'REOPEN_WINDOW_EXPIRED',
      });
      return;
    }

    await withTransaction(async (client) => {
      await appendEvent(client as Parameters<typeof appendEvent>[0], ticket.id, 'CUSTOMER', 'STATUS_CHANGED', {
        from: 'RESOLVED', to: 'OPEN',
      });
      await appendEvent(client as Parameters<typeof appendEvent>[0], ticket.id, 'CUSTOMER', 'TICKET_REOPENED', {});
      await appendEvent(client as Parameters<typeof appendEvent>[0], ticket.id, 'CUSTOMER', 'CLOCK_RESUMED', {});

      await client.query(
        `UPDATE tickets
         SET status = 'OPEN', resolved_at = NULL, resolution_sla_met = NULL,
             version = version + 1
         WHERE id = $1`,
        [ticket.id]
      );
    });

    res.json({ ok: true, message: 'Ticket reopened' });
  } catch (err) {
    next(err);
  }
});

export default router;
