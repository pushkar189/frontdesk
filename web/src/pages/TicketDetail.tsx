import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  api, Ticket, Message, TicketEvent, SlaState,
  formatDate, formatMinutes, remainingMinutes
} from '../api/client';
import { useAuth } from '../components/AuthContext';
import { SLA_TARGETS } from '../config';

function SlaPanel({ ticket, slaState }: { ticket: Ticket; slaState: SlaState | null }) {
  if (!slaState) return null;

  const priority = ticket.priority;
  const targets = SLA_TARGETS[priority];

  const renderClock = (
    label: string,
    elapsed: number,
    target: number,
    done: boolean,
    metOrNull: boolean | null,
    dueAt: string | null
  ) => {
    let cls = 'sla-clock';
    let statusText = '';

    if (slaState.isPaused) {
      cls += ' paused';
      statusText = '⏸ Paused (waiting on customer)';
    } else if (done) {
      cls += metOrNull ? ' met' : ' breached';
      statusText = metOrNull ? '✅ Met' : '❌ Breached';
    } else if (dueAt && remainingMinutes(dueAt) !== null && remainingMinutes(dueAt)! < 0) {
      cls += ' breached';
      statusText = `❌ Late by ${formatMinutes(-remainingMinutes(dueAt)!)}`;
    }

    const remaining = target - elapsed;

    return (
      <div className={cls}>
        <h4>{label}</h4>
        <div className="sla-time" style={{ marginBottom: 4 }}>
          {done ? (
            <span className={metOrNull ? 'green' : 'red'}>
              {formatMinutes(elapsed)} / {formatMinutes(target)}
            </span>
          ) : slaState.isPaused ? (
            <span className="yellow">{formatMinutes(elapsed)} elapsed</span>
          ) : remaining < 0 ? (
            <span className="red">{formatMinutes(-remaining)} overdue</span>
          ) : (
            <span>{formatMinutes(remaining)} remaining</span>
          )}
        </div>
        {statusText && <div className="text-sm">{statusText}</div>}
        {!done && dueAt && !slaState.isPaused && (
          <div className="text-sm text-muted">Due: {formatDate(dueAt)}</div>
        )}
      </div>
    );
  };

  return (
    <div className="sla-panel">
      {renderClock(
        'First Response',
        slaState.firstResponseElapsedMinutes,
        targets.firstReplyMinutes,
        slaState.isFirstResponseDone,
        ticket.first_response_sla_met,
        ticket.response_due_at
      )}
      {renderClock(
        'Resolution',
        slaState.resolutionElapsedMinutes,
        targets.resolutionMinutes,
        slaState.isResolutionDone,
        ticket.resolution_sla_met,
        ticket.resolution_due_at
      )}
    </div>
  );
}

function EventTimeline({ events, ticketCreatedAt }: { events: TicketEvent[]; ticketCreatedAt: string }) {
  const labels: Record<string, string> = {
    TICKET_CREATED: '🆕 Ticket created',
    TICKET_CLAIMED: '🙋 Claimed',
    TICKET_RELEASED: '↩️ Released',
    PUBLIC_REPLY: '💬 Public reply',
    INTERNAL_NOTE: '🔒 Internal note added (team only)',
    STATUS_CHANGED: '🔄 Status changed',
    PRIORITY_CHANGED: '⚡ Priority changed',
    CLOCK_PAUSED: '⏸ Clock paused',
    CLOCK_RESUMED: '▶️ Clock resumed',
    TICKET_REOPENED: '🔃 Ticket reopened',
    TICKET_AUTO_CLOSED: '🤖 Auto-closed',
    TICKET_CLOSED: '🔒 Closed',
  };

  return (
    <div className="card mt-16">
      <h3 style={{ marginBottom: 12 }}>Event Timeline</h3>
      <ul className="timeline">
        {events.map((ev, i) => {
          const actor = ev.actor_name ?? ev.actor;
          const details = ev.details ?? {};
          let detail = '';
          if (ev.event_type === 'STATUS_CHANGED') {
            detail = `${(details as { from?: string }).from} → ${(details as { to?: string }).to}`;
          } else if (ev.event_type === 'PRIORITY_CHANGED') {
            detail = `${(details as { from?: string }).from} → ${(details as { to?: string }).to}`;
          } else if (ev.event_type === 'TICKET_CLAIMED') {
            detail = `by ${actor}`;
          }

          return (
            <li key={ev.id}>
              <div className="dot" />
              <div style={{ flex: 1 }}>
                <span className="font-medium" style={{ color: '#374151' }}>
                  {labels[ev.event_type] ?? ev.event_type}
                </span>
                {detail && <span className="text-muted"> — {detail}</span>}
                {actor && actor !== 'CUSTOMER' && actor !== 'SYSTEM' && ev.event_type !== 'TICKET_CLAIMED' && (
                  <span className="text-muted"> by {actor}</span>
                )}
              </div>
              <div className="text-sm text-muted">{formatDate(ev.created_at)}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function TicketDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<TicketEvent[]>([]);
  const [slaState, setSlaState] = useState<SlaState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [visibility, setVisibility] = useState<'PUBLIC' | 'INTERNAL'>('PUBLIC');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    const res = await api.get<{
      ticket: Ticket;
      messages: Message[];
      events: TicketEvent[];
      slaState: SlaState;
    }>(`/tickets/${id}`);

    if (res.data) {
      setTicket(res.data.ticket);
      setMessages(res.data.messages);
      setEvents(res.data.events);
      setSlaState(res.data.slaState);
      setError('');
    } else {
      setError(res.error ?? 'Failed to load ticket');
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const claim = async () => {
    if (!ticket) return;
    const res = await api.post<Ticket>(`/tickets/${ticket.id}/claim`, {});
    if (res.error) {
      setError(res.error);
    } else {
      await load();
    }
  };

  const changeStatus = async (newStatus: string) => {
    if (!ticket) return;
    const res = await api.patch<Ticket>(`/tickets/${ticket.id}/status`, { status: newStatus });
    if (res.error) {
      setError(res.error);
      if (res.status === 409) await load(); // Refresh on conflict
    } else {
      await load();
    }
  };

  const changePriority = async (newPriority: string) => {
    if (!ticket) return;
    const res = await api.patch<Ticket>(`/tickets/${ticket.id}/priority`, { priority: newPriority });
    if (res.error) {
      setError(res.error);
    } else {
      await load();
    }
  };

  const postMessage = async () => {
    if (!ticket || !msg.trim()) return;
    setPosting(true);
    setPostError('');

    const res = await api.post(`/tickets/${ticket.id}/messages`, { body: msg.trim(), visibility });
    if (res.error) {
      setPostError(res.error);
    } else {
      setMsg('');
      await load();
    }
    setPosting(false);
  };

  if (loading) return <div className="container text-muted">Loading...</div>;
  if (error && !ticket) return <div className="container"><div className="alert error">{error}</div></div>;
  if (!ticket) return null;

  const isAssignedToMe = ticket.assignee_id === user?.id;
  const isManager = user?.role === 'MANAGER';
  const canAct = isAssignedToMe || isManager;

  const statusOptions: Record<string, string[]> = {
    OPEN: ['WAITING_ON_CUSTOMER', 'RESOLVED', ...(isManager ? ['CLOSED'] : [])],
    WAITING_ON_CUSTOMER: ['OPEN', ...(isManager ? ['CLOSED'] : [])],
    RESOLVED: ['OPEN', 'CLOSED'],
  };

  const allowedStatuses = statusOptions[ticket.status] ?? [];

  return (
    <div className="layout">
      <nav className="nav">
        <span className="brand">🎫 <span>Frontdesk</span></span>
        <button onClick={() => navigate('/')} style={{ fontSize: '12px', padding: '4px 10px' }}>
          ← Back
        </button>
        <div className="spacer" />
        <span className="user-info">{user?.name}</span>
      </nav>

      <div className="container" style={{ maxWidth: 900 }}>
        {error && <div className="alert error">{error}</div>}

        {/* Header */}
        <div className="card mb-12">
          <div className="flex gap-12" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: 1 }}>
              <h1 style={{ fontSize: '18px', marginBottom: 8 }}>{ticket.subject}</h1>
              <div className="flex gap-8" style={{ flexWrap: 'wrap' }}>
                <span className={`badge ${ticket.priority.toLowerCase()}`}>{ticket.priority}</span>
                <span className={`badge ${ticket.status === 'WAITING_ON_CUSTOMER' ? 'waiting' : ticket.status.toLowerCase()}`}>
                  {ticket.status}
                </span>
                {ticket.assignee_name && (
                  <span className="text-sm text-muted">👤 {ticket.assignee_name}</span>
                )}
                {!ticket.assignee_id && (
                  <span className="badge new">Unassigned</span>
                )}
              </div>
            </div>
            <div className="text-sm text-muted" style={{ textAlign: 'right' }}>
              <div>#{ticket.id.slice(0, 8)}</div>
              <div>{ticket.customer_name}</div>
              <div>{ticket.customer_email}</div>
              <div>Created: {formatDate(ticket.created_at)}</div>
            </div>
          </div>

          {/* Controls */}
          {canAct && ticket.status !== 'CLOSED' && (
            <div className="controls mt-16">
              {!ticket.assignee_id && ticket.status === 'NEW' && (
                <button className="primary" onClick={claim}>Claim Ticket</button>
              )}

              {allowedStatuses.length > 0 && (
                <select
                  value=""
                  onChange={e => { if (e.target.value) changeStatus(e.target.value); }}
                >
                  <option value="">Change Status...</option>
                  {allowedStatuses.map(s => (
                    <option key={s} value={s}>{s.replace('_', ' ')}</option>
                  ))}
                </select>
              )}

              <select
                value={ticket.priority}
                onChange={e => changePriority(e.target.value)}
              >
                <option value="URGENT">URGENT</option>
                <option value="MEDIUM">MEDIUM</option>
                <option value="LOW">LOW</option>
              </select>
            </div>
          )}
        </div>

        {/* SLA Panel */}
        <SlaPanel ticket={ticket} slaState={slaState} />

        {/* Thread */}
        <div className="thread">
          {/* Original description */}
          <div className="message customer">
            <div className="message-header">
              <span className="message-author">{ticket.customer_name}</span>
              <span className="badge new">Customer</span>
              <span className="message-time">{formatDate(ticket.created_at)}</span>
            </div>
            <div className="message-body">{ticket.description}</div>
          </div>

          {messages.map(m => (
            <div
              key={m.id}
              className={`message ${
                m.author_type === 'CUSTOMER' ? 'customer' :
                m.visibility === 'INTERNAL' ? 'agent-internal' :
                'agent-public'
              }`}
            >
              <div className="message-header">
                <span className="message-author">
                  {m.author_name ?? (m.author_type === 'CUSTOMER' ? ticket.customer_name : 'System')}
                </span>
                {m.author_type === 'CUSTOMER' && <span className="badge new">Customer</span>}
                {m.visibility === 'INTERNAL' && <span className="badge internal">🔒 Only visible to the team</span>}
                <span className="message-time">{formatDate(m.created_at)}</span>
              </div>
              <div className="message-body">{m.body}</div>
            </div>
          ))}
        </div>

        {/* Composer */}
        {canAct && !['CLOSED', 'RESOLVED'].includes(ticket.status) && (
          <div className="composer">
            <div className="composer-toggle">
              <button
                className={visibility === 'PUBLIC' ? 'active' : ''}
                onClick={() => setVisibility('PUBLIC')}
              >
                💬 Reply to customer
              </button>
              <button
                className={visibility === 'INTERNAL' ? 'active' : ''}
                onClick={() => setVisibility('INTERNAL')}
              >
                🔒 Internal note (team only)
              </button>
            </div>

            {visibility === 'INTERNAL' && (
              <div className="internal-warning">
                🔒 This note is ONLY visible to the support team. The customer will NOT see this.
              </div>
            )}

            {postError && <div className="alert error mb-8">{postError}</div>}

            <textarea
              value={msg}
              onChange={e => setMsg(e.target.value)}
              placeholder={visibility === 'PUBLIC' ? 'Reply to customer...' : 'Internal note (team only)...'}
              rows={4}
              style={visibility === 'INTERNAL' ? { borderColor: 'var(--internal-border)', background: 'var(--internal-bg)' } : {}}
            />
            <div className="mt-8">
              <button
                className="primary"
                onClick={postMessage}
                disabled={posting || !msg.trim()}
              >
                {posting ? 'Posting...' : visibility === 'PUBLIC' ? 'Send Reply' : 'Add Internal Note'}
              </button>
            </div>
          </div>
        )}

        {/* Event Timeline */}
        <EventTimeline events={events} ticketCreatedAt={ticket.created_at} />
      </div>
    </div>
  );
}
