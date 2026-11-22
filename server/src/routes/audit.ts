import { Router, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { query, queryOne } from '../db/pool';
import { requireAuth, requireManager, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth, requireManager);

// GET /api/audit/verify — verify hash chain integrity
router.get('/verify', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const events = await query<{
      id: string;
      ticket_id: string;
      actor: string;
      event_type: string;
      details: Record<string, unknown>;
      prev_hash: string;
      hash: string;
      created_at: Date;
    }>(
      `SELECT id, ticket_id, actor, event_type, details, prev_hash, hash, created_at
       FROM ticket_events ORDER BY id ASC`
    );

    // Build prev_hash map per ticket
    const lastHashByTicket: Record<string, string> = {};
    const tampered: Array<{ id: string; reason: string }> = [];

    for (const event of events) {
      const ticketId = event.ticket_id;
      const expectedPrevHash = lastHashByTicket[ticketId] ?? '';

      if (event.prev_hash !== expectedPrevHash) {
        tampered.push({
          id: event.id,
          reason: `prev_hash mismatch: expected ${expectedPrevHash}, got ${event.prev_hash}`,
        });
      }

      // Recompute hash
      const payload = JSON.stringify({
        ticketId: event.ticket_id,
        actor: event.actor,
        eventType: event.event_type,
        details: event.details,
        prevHash: event.prev_hash,
      });
      const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');

      if (event.hash !== expectedHash) {
        tampered.push({
          id: event.id,
          reason: `hash mismatch: expected ${expectedHash}, got ${event.hash}`,
        });
      }

      lastHashByTicket[ticketId] = event.hash;
    }

    res.json({
      ok: tampered.length === 0,
      total_events: events.length,
      tampered_count: tampered.length,
      tampered: tampered.slice(0, 100), // cap output
    });
  } catch (err) {
    next(err);
  }
});

export default router;
