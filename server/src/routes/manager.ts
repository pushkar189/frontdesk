import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db/pool';
import { requireAuth, requireManager, AuthRequest } from '../middleware/auth';
import * as crypto from 'crypto';

const router = Router();
router.use(requireAuth);

// ── Holidays CRUD (MANAGER only) ──────────────────────────────
router.get('/holidays', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const holidays = await query<{ id: number; date: string; name: string }>(
      `SELECT id, date::text, name, created_at FROM holidays ORDER BY date`
    );
    res.json(holidays);
  } catch (err) { next(err); }
});

router.post('/holidays', requireManager, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const Schema = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      name: z.string().min(1).max(200),
    });
    const { date, name } = Schema.parse(req.body);
    const row = await queryOne<{ id: number; date: string; name: string }>(
      `INSERT INTO holidays (date, name) VALUES ($1, $2)
       ON CONFLICT (date) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, date::text, name`,
      [date, name]
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.delete('/holidays/:id', requireManager, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await query(`DELETE FROM holidays WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Late tickets report ───────────────────────────────────────
router.get('/late-tickets', requireManager, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const rows = await query<Record<string, unknown>>(`
      SELECT
        t.id, t.subject, t.priority, t.status,
        t.customer_name, t.customer_email,
        t.created_at, t.resolved_at,
        t.response_due_at, t.resolution_due_at,
        t.first_responded_at,
        t.first_response_sla_met, t.resolution_sla_met,
        u.name AS assignee_name,
        CASE
          WHEN t.first_response_sla_met = false THEN true
          WHEN t.resolution_sla_met = false THEN true
          WHEN t.response_due_at IS NOT NULL AND NOW() > t.response_due_at AND t.first_responded_at IS NULL THEN true
          WHEN t.resolution_due_at IS NOT NULL AND NOW() > t.resolution_due_at AND t.resolved_at IS NULL THEN true
          ELSE false
        END AS is_late
      FROM tickets t
      LEFT JOIN users u ON t.assignee_id = u.id
      WHERE
        t.first_response_sla_met = false
        OR t.resolution_sla_met = false
        OR (t.response_due_at IS NOT NULL AND NOW() > t.response_due_at AND t.first_responded_at IS NULL)
        OR (t.resolution_due_at IS NOT NULL AND NOW() > t.resolution_due_at AND t.resolved_at IS NULL)
      ORDER BY t.created_at DESC
    `);

    res.json(rows);
  } catch (err) { next(err); }
});

// ── CSV export (NO internal note content) ────────────────────
router.get('/export/csv', requireManager, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tickets = await query<Record<string, unknown>>(`
      SELECT
        t.id, t.subject, t.priority, t.status,
        t.customer_name, t.customer_email,
        t.created_at, t.resolved_at,
        t.first_response_sla_met, t.resolution_sla_met,
        u.name AS assignee_name,
        COUNT(m.id) FILTER (WHERE m.visibility = 'PUBLIC') AS public_message_count
      FROM tickets t
      LEFT JOIN users u ON t.assignee_id = u.id
      LEFT JOIN messages m ON m.ticket_id = t.id
      GROUP BY t.id, u.name
      ORDER BY t.created_at DESC
    `);

    const headers = [
      'id', 'subject', 'priority', 'status', 'customer_name', 'customer_email',
      'assignee_name', 'created_at', 'resolved_at',
      'first_response_sla_met', 'resolution_sla_met', 'public_message_count',
    ];

    const escape = (v: unknown) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const lines = [
      headers.join(','),
      ...tickets.map(t => headers.map(h => escape(t[h])).join(',')),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="frontdesk-tickets.csv"');
    res.send(lines.join('\r\n'));
  } catch (err) { next(err); }
});

export default router;
