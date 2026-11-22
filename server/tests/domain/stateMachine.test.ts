import { describe, it, expect } from 'vitest';
import { validateTransition, InvalidTransitionError, TRANSITION_TABLE } from '../../src/domain/stateMachine';
import { TicketStatus } from '../../src/config/constants';

describe('stateMachine', () => {
  it('allows NEW → OPEN', () => {
    expect(() => validateTransition('NEW', 'OPEN')).not.toThrow();
  });

  it('allows OPEN → WAITING_ON_CUSTOMER', () => {
    expect(() => validateTransition('OPEN', 'WAITING_ON_CUSTOMER')).not.toThrow();
  });

  it('allows OPEN → RESOLVED', () => {
    expect(() => validateTransition('OPEN', 'RESOLVED')).not.toThrow();
  });

  it('allows WAITING_ON_CUSTOMER → OPEN', () => {
    expect(() => validateTransition('WAITING_ON_CUSTOMER', 'OPEN')).not.toThrow();
  });

  it('allows RESOLVED → OPEN (reopen)', () => {
    expect(() => validateTransition('RESOLVED', 'OPEN')).not.toThrow();
  });

  it('allows RESOLVED → CLOSED', () => {
    expect(() => validateTransition('RESOLVED', 'CLOSED')).not.toThrow();
  });

  it('rejects NEW → RESOLVED (invalid)', () => {
    expect(() => validateTransition('NEW', 'RESOLVED')).toThrow(InvalidTransitionError);
  });

  it('rejects CLOSED → anything (terminal)', () => {
    const statuses: TicketStatus[] = ['NEW', 'OPEN', 'WAITING_ON_CUSTOMER', 'RESOLVED'];
    for (const s of statuses) {
      expect(() => validateTransition('CLOSED', s)).toThrow(InvalidTransitionError);
    }
  });

  it('rejects NEW → WAITING_ON_CUSTOMER', () => {
    expect(() => validateTransition('NEW', 'WAITING_ON_CUSTOMER')).toThrow(InvalidTransitionError);
  });

  it('rejects WAITING_ON_CUSTOMER → RESOLVED', () => {
    expect(() => validateTransition('WAITING_ON_CUSTOMER', 'RESOLVED')).toThrow(InvalidTransitionError);
  });
});
