import { getPool, withTransaction, query } from '../db/pool';
import { appendEvent } from '../domain/sla';
import { AUTO_CLOSE_WORKING_MINUTES, REOPEN_WINDOW_CALENDAR_DAYS } from '../config/constants';
import { workingMinutesBetween, WorkingTimeConfig } from '../domain/workingTime';
import { WORKING_HOURS } from '../config/constants';
import { getHolidaysFromDB } from '../domain/sla';

let isSweepRunning = false;

export async function runSweep(): Promise<void> {
  // Idempotent: skip if already running
  if (isSweepRunning) return;
  isSweepRunning = true;

  try {
    const holidays = await getHolidaysFromDB();
    const getHols = async () => holidays;
    const now = new Date();

    // 1. Auto-close: WAITING_ON_CUSTOMER tickets with no customer reply for 2700 working minutes
    const waitingTickets = await query<{
      id: string;
      last_customer_reply: Date | null;
      status_changed_at: Date | null;
      waiting_since: Date | null;
    }>(`
      SELECT
        t.id,
        (
          SELECT MAX(te.created_at)
          FROM ticket_events te
          WHERE te.ticket_id = t.id AND te.event_type = 'CLOCK_PAUSED'
        ) AS waiting_since
      FROM tickets t
      WHERE t.status = 'WAITING_ON_CUSTOMER'
    `);

    for (const ticket of waitingTickets) {
      if (!ticket.waiting_since) continue;

      const waitingSince = new Date(ticket.waiting_since);
      const workingMinutes = await workingMinutesBetween(waitingSince, now, WORKING_HOURS, getHols);

      if (workingMinutes >= AUTO_CLOSE_WORKING_MINUTES) {
        await withTransaction(async (client) => {
          // Use advisory lock to prevent concurrent sweeps from double-processing
          const lockResult = await client.query(
            `SELECT pg_try_advisory_xact_lock(hashtext($1::text))`,
            [ticket.id]
          );
          const locked = (lockResult.rows[0] as { pg_try_advisory_xact_lock: boolean }).pg_try_advisory_xact_lock;
          if (!locked) return; // Another process is handling this

          // Double-check status hasn't changed
          const current = await client.query(
            `SELECT status FROM tickets WHERE id = $1 FOR UPDATE`,
            [ticket.id]
          );
          const currentStatus = (current.rows[0] as { status: string } | undefined)?.status;
          if (currentStatus !== 'WAITING_ON_CUSTOMER') return;

          await client.query(
            `UPDATE tickets SET status = 'CLOSED', version = version + 1 WHERE id = $1`,
            [ticket.id]
          );

          await appendEvent(client as Parameters<typeof appendEvent>[0], ticket.id, 'SYSTEM', 'TICKET_AUTO_CLOSED', {
            reason: 'No customer reply after 2700 working minutes',
            waiting_since: waitingSince.toISOString(),
          });
          await appendEvent(client as Parameters<typeof appendEvent>[0], ticket.id, 'SYSTEM', 'STATUS_CHANGED', {
            from: 'WAITING_ON_CUSTOMER', to: 'CLOSED',
          });
        });
      }
    }

    // 2. Auto-close RESOLVED tickets past 7 calendar day reopen window
    const resolvedTickets = await query<{ id: string; resolved_at: Date }>(
      `SELECT id, resolved_at FROM tickets WHERE status = 'RESOLVED' AND resolved_at IS NOT NULL`
    );

    for (const ticket of resolvedTickets) {
      const resolvedAt = new Date(ticket.resolved_at);
      const daysDiff = (now.getTime() - resolvedAt.getTime()) / (1000 * 60 * 60 * 24);

      if (daysDiff > REOPEN_WINDOW_CALENDAR_DAYS) {
        await withTransaction(async (client) => {
          const lockResult = await client.query(
            `SELECT pg_try_advisory_xact_lock(hashtext($1::text))`,
            [ticket.id]
          );
          const locked = (lockResult.rows[0] as { pg_try_advisory_xact_lock: boolean }).pg_try_advisory_xact_lock;
          if (!locked) return;

          const current = await client.query(
            `SELECT status FROM tickets WHERE id = $1 FOR UPDATE`,
            [ticket.id]
          );
          const currentStatus = (current.rows[0] as { status: string } | undefined)?.status;
          if (currentStatus !== 'RESOLVED') return;

          await client.query(
            `UPDATE tickets SET status = 'CLOSED', version = version + 1 WHERE id = $1`,
            [ticket.id]
          );

          await appendEvent(client as Parameters<typeof appendEvent>[0], ticket.id, 'SYSTEM', 'TICKET_CLOSED', {
            reason: 'Reopen window expired (7 calendar days)',
            resolved_at: resolvedAt.toISOString(),
          });
          await appendEvent(client as Parameters<typeof appendEvent>[0], ticket.id, 'SYSTEM', 'STATUS_CHANGED', {
            from: 'RESOLVED', to: 'CLOSED',
          });
        });
      }
    }
  } catch (err) {
    console.error('[sweep] Error:', err);
  } finally {
    isSweepRunning = false;
  }
}

export function startScheduler(): void {
  // Run every 60 seconds
  const INTERVAL_MS = 60 * 1000;
  console.log('[sweep] Scheduler started (interval: 60s)');

  setInterval(() => {
    runSweep().catch(console.error);
  }, INTERVAL_MS);

  // Run immediately on startup
  runSweep().catch(console.error);
}
