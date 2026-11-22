import { TicketStatus } from '../config/constants';

// Explicit allowed transitions
// Key: from status, Value: set of allowed to statuses
export const TRANSITION_TABLE: Record<TicketStatus, TicketStatus[]> = {
  NEW: ['OPEN'],
  OPEN: ['WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'],
  WAITING_ON_CUSTOMER: ['OPEN', 'CLOSED'],
  RESOLVED: ['OPEN', 'CLOSED'],
  CLOSED: [], // terminal; linked ticket created instead
};

export class InvalidTransitionError extends Error {
  constructor(from: TicketStatus, to: TicketStatus) {
    super(`Invalid transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function validateTransition(from: TicketStatus, to: TicketStatus): void {
  const allowed = TRANSITION_TABLE[from] ?? [];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function isTerminal(status: TicketStatus): boolean {
  return status === 'CLOSED';
}

export function isPaused(status: TicketStatus): boolean {
  return status === 'WAITING_ON_CUSTOMER';
}
