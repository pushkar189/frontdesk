import * as crypto from 'crypto';
import { query, queryOne, withTransaction } from '../db/pool';
import { getPool } from '../db/pool';
import {
  Priority,
  SLA_TARGETS,
  WORKING_HOURS,
  AUTO_CLOSE_WORKING_MINUTES,
  EventType,
  PUBLIC_EVENT_TYPES,
} from '../config/constants';
import { addWorkingMinutes, workingMinutesBetween } from './workingTime';

export type HolidayFetcher = () => Promise<Set<string>>;

let _holidayFetcher: HolidayFetcher = async () => new Set<string>();

export function setHolidayFetcher(fn: HolidayFetcher): void {
  _holidayFetcher = fn;
}

export async function getHolidaysFromDB(): Promise<Set<string>> {
  const rows = await query<{ date: string }>('SELECT date::text FROM holidays');
  return new Set(rows.map((r) => r.date.substring(0, 10)));
}

/**
 * Compute the initial due timestamps for a new ticket.
 */
export async function computeInitialDueDates(
  createdAt: Date,
  priority: Priority
): Promise<{ responseDueAt: Date; resolutionDueAt: Date }> {
  const target = SLA_TARGETS[priority];
  const holidays = await _holidayFetcher();
  const getHols = async () => holidays;

  const [responseDueAt, resolutionDueAt] = await Promise.all([
    addWorkingMinutes(createdAt, target.firstReplyMinutes, WORKING_HOURS, getHols),
    addWorkingMinutes(createdAt, target.resolutionMinutes, WORKING_HOURS, getHols),
  ]);

  return { responseDueAt, resolutionDueAt };
}

export interface SlaInterval {
  start: Date;
  end: Date | null; // null = still running
}

/**
 * Compute SLA intervals from the event log.
 * Returns separate intervals for first-response and resolution clocks.
 */
export interface SlaState {
  firstResponseIntervals: SlaInterval[];
  resolutionIntervals: SlaInterval[];
  firstResponseElapsedMinutes: number;
  resolutionElapsedMinutes: number;
  isFirstResponseDone: boolean;
  isResolutionDone: boolean;
  isPaused: boolean;
}

export async function computeSlaState(
  ticketId: string,
  now: Date = new Date()
): Promise<SlaState> {
  const events = await query<{
    event_type: string;
    actor: string;
    created_at: Date;
    details: Record<string, unknown>;
  }>(
    `SELECT event_type, actor, created_at, details
     FROM ticket_events
     WHERE ticket_id = $1
     ORDER BY id ASC`,
    [ticketId]
  );

  const holidays = await _holidayFetcher();
  const getHols = async () => holidays;

  let createdAt: Date | null = null;
  let firstResponseIntervals: SlaInterval[] = [];
  let resolutionIntervals: SlaInterval[] = [];
  let isPaused = false;
  let isFirstResponseDone = false;
  let isResolutionDone = false;

  let currentWindowStart: Date | null = null;

  for (const event of events) {
    const ts = new Date(event.created_at);

    if (event.event_type === 'TICKET_CREATED') {
      createdAt = ts;
      currentWindowStart = ts;
    } else if (event.event_type === 'CLOCK_PAUSED') {
      if (currentWindowStart && !isPaused) {
        firstResponseIntervals.push({ start: currentWindowStart, end: ts });
        resolutionIntervals.push({ start: currentWindowStart, end: ts });
        isPaused = true;
        currentWindowStart = null;
      }
    } else if (event.event_type === 'CLOCK_RESUMED') {
      if (isPaused) {
        isPaused = false;
        currentWindowStart = ts;
      }
    } else if (event.event_type === 'PUBLIC_REPLY' && event.actor !== 'CUSTOMER') {
      // First public agent reply
      if (!isFirstResponseDone && currentWindowStart) {
        firstResponseIntervals.push({ start: currentWindowStart, end: ts });
        isFirstResponseDone = true;
      }
    } else if (
      event.event_type === 'STATUS_CHANGED' &&
      (event.details as { to?: string }).to === 'RESOLVED'
    ) {
      if (!isResolutionDone && currentWindowStart) {
        resolutionIntervals.push({ start: currentWindowStart, end: ts });
        isResolutionDone = true;
      }
    }
  }

  // Add open interval if still running
  if (currentWindowStart && !isPaused && !isResolutionDone) {
    resolutionIntervals.push({ start: currentWindowStart, end: null });
  }
  if (currentWindowStart && !isPaused && !isFirstResponseDone) {
    firstResponseIntervals.push({ start: currentWindowStart, end: null });
  }

  async function totalMinutes(intervals: SlaInterval[]): Promise<number> {
    let total = 0;
    for (const iv of intervals) {
      const end = iv.end ?? now;
      total += await workingMinutesBetween(iv.start, end, WORKING_HOURS, getHols);
    }
    return total;
  }

  const [firstResponseElapsedMinutes, resolutionElapsedMinutes] = await Promise.all([
    totalMinutes(firstResponseIntervals),
    totalMinutes(resolutionIntervals),
  ]);

  return {
    firstResponseIntervals,
    resolutionIntervals,
    firstResponseElapsedMinutes,
    resolutionElapsedMinutes,
    isFirstResponseDone,
    isResolutionDone,
    isPaused,
  };
}

/**
 * Recompute due dates after a priority change.
 * Does NOT restart the clock — keeps elapsed time, extends/shrinks from now.
 */
export async function recomputeDueDatesAfterPriorityChange(
  ticketId: string,
  newPriority: Priority,
  now: Date = new Date()
): Promise<{ responseDueAt: Date | null; resolutionDueAt: Date | null }> {
  const state = await computeSlaState(ticketId, now);
  const target = SLA_TARGETS[newPriority];
  const holidays = await _holidayFetcher();
  const getHols = async () => holidays;

  let responseDueAt: Date | null = null;
  let resolutionDueAt: Date | null = null;

  if (!state.isFirstResponseDone && !state.isPaused) {
    const remainingReply = Math.max(0, target.firstReplyMinutes - state.firstResponseElapsedMinutes);
    responseDueAt = await addWorkingMinutes(now, remainingReply, WORKING_HOURS, getHols);
  }

  if (!state.isResolutionDone && !state.isPaused) {
    const remainingResolution = Math.max(0, target.resolutionMinutes - state.resolutionElapsedMinutes);
    resolutionDueAt = await addWorkingMinutes(now, remainingResolution, WORKING_HOURS, getHols);
  }

  return { responseDueAt, resolutionDueAt };
}

/**
 * Append an event to ticket_events with hash chain.
 */
export async function appendEvent(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  ticketId: string,
  actor: string,
  eventType: EventType,
  details: Record<string, unknown> = {}
): Promise<void> {
  // Get last hash
  const lastResult = await client.query(
    `SELECT hash FROM ticket_events WHERE ticket_id = $1 ORDER BY id DESC LIMIT 1`,
    [ticketId]
  );
  const prevHash = (lastResult.rows as { hash: string }[])[0]?.hash ?? '';

  // Compute new hash
  const payload = JSON.stringify({ ticketId, actor, eventType, details, prevHash });
  const hash = crypto.createHash('sha256').update(payload).digest('hex');

  // Sanitize details: internal note bodies must NOT be stored in event details
  const safeDetails = eventType === 'INTERNAL_NOTE'
    ? { note: 'Internal note created (body omitted from event log)' }
    : details;

  await client.query(
    `INSERT INTO ticket_events (ticket_id, actor, event_type, details, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ticketId, actor, eventType, JSON.stringify(safeDetails), prevHash, hash]
  );
}
