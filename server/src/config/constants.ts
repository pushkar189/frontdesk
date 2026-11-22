// SLA targets and working-time configuration
// ALL times in working minutes
// One working day = 9 hours = 540 minutes (09:30 – 18:30 IST, Mon–Fri)

export const WORKING_HOURS = {
  startHour: 9,
  startMinute: 30,
  endHour: 18,
  endMinute: 30,
  timezone: 'Asia/Kolkata',
  workdayMinutes: 540, // 9 * 60
} as const;

export type Priority = 'URGENT' | 'MEDIUM' | 'LOW';

export interface SlaTarget {
  firstReplyMinutes: number;
  resolutionMinutes: number;
}

// All times in working minutes
export const SLA_TARGETS: Record<Priority, SlaTarget> = {
  URGENT: {
    firstReplyMinutes: 120,  // 2 working hours
    resolutionMinutes: 540,  // 1 working day
  },
  MEDIUM: {
    firstReplyMinutes: 270,  // half a working day
    resolutionMinutes: 1620, // 3 working days
  },
  LOW: {
    firstReplyMinutes: 540,  // 1 working day
    resolutionMinutes: 2700, // 5 working days
  },
} as const;

// Auto-close: WAITING_ON_CUSTOMER for this many working minutes → CLOSED
export const AUTO_CLOSE_WORKING_MINUTES = 2700; // 5 working days

// Reopen window: customer can reopen a RESOLVED ticket within this many calendar days
export const REOPEN_WINDOW_CALENDAR_DAYS = 7;

// "Due soon" threshold: show DUE SOON badge when less than this many working minutes remain
export const DUE_SOON_THRESHOLD_MINUTES = 30;

// Customer-facing impact labels → priority mapping
export const IMPACT_TO_PRIORITY: Record<string, Priority> = {
  'cannot work at all': 'URGENT',
  'partly affected': 'MEDIUM',
  'question or request': 'LOW',
};

export type TicketStatus =
  | 'NEW'
  | 'OPEN'
  | 'WAITING_ON_CUSTOMER'
  | 'RESOLVED'
  | 'CLOSED';

export type EventType =
  | 'TICKET_CREATED'
  | 'TICKET_CLAIMED'
  | 'TICKET_RELEASED'
  | 'PUBLIC_REPLY'
  | 'INTERNAL_NOTE'
  | 'STATUS_CHANGED'
  | 'PRIORITY_CHANGED'
  | 'CLOCK_PAUSED'
  | 'CLOCK_RESUMED'
  | 'TICKET_REOPENED'
  | 'TICKET_AUTO_CLOSED'
  | 'TICKET_CLOSED';

export type ActorType = 'AGENT' | 'CUSTOMER' | 'SYSTEM';

export type MessageVisibility = 'PUBLIC' | 'INTERNAL';

export type UserRole = 'AGENT' | 'MANAGER';

// Public event types that may appear in customer-facing responses
export const PUBLIC_EVENT_TYPES: EventType[] = [
  'TICKET_CREATED',
  'PUBLIC_REPLY',
  'STATUS_CHANGED',
  'TICKET_REOPENED',
  'TICKET_CLOSED',
  'TICKET_AUTO_CLOSED',
];
