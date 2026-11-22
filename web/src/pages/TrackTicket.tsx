import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, formatDate } from '../api/client';

interface PublicTicket {
  id: string;
  tracking_token: string;
  subject: string;
  description: string;
  customer_name: string;
  priority: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  parent_ticket_id: string | null;
}

interface PublicMessage {
  id: string;
  author_type: string;
  author_name: string | null;
  body: string;
  created_at: string;
}

export default function TrackTicket() {
  const { token } = useParams<{ token: string }>();
  const [ticket, setTicket] = useState<PublicTicket | null>(null);
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [replyError, setReplyError] = useState('');
  const [replyOk, setReplyOk] = useState('');

  const load = async () => {
    if (!token) return;
    const res = await api.get<{ ticket: PublicTicket; messages: PublicMessage[] }>(
      `/public/tickets/${token}`
    );
    if (res.data) {
      setTicket(res.data.ticket);
      setMessages(res.data.messages);
    } else {
      setError(res.error ?? 'Ticket not found');
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [token]);

  const sendReply = async () => {
    if (!token || !reply.trim()) return;
    setSending(true);
    setReplyError('');
    setReplyOk('');

    const res = await api.post<{ ok: boolean; tracking_token?: string; message?: string }>(
      `/public/tickets/${token}/reply`,
      { body: reply.trim() }
    );

    if (res.data?.ok || res.data?.message) {
      setReply('');
      setReplyOk(res.data.message ?? 'Reply sent!');
      await load();
    } else {
      setReplyError(res.error ?? 'Failed to send reply');
    }
    setSending(false);
  };

  const reopen = async () => {
    if (!token) return;
    const res = await api.post<{ ok: boolean; message?: string }>(
      `/public/tickets/${token}/reopen`,
      {}
    );
    if (res.data?.ok) {
      setReplyOk('Ticket reopened!');
      await load();
    } else {
      setReplyError(res.error ?? 'Failed to reopen');
    }
  };

  const statusColors: Record<string, string> = {
    NEW: '#6b7280',
    OPEN: '#065f46',
    WAITING_ON_CUSTOMER: '#1e40af',
    RESOLVED: '#1e40af',
    CLOSED: '#6b7280',
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p>Loading ticket...</p>
      </div>
    );
  }

  if (error || !ticket) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="card" style={{ maxWidth: 400, width: '100%', margin: '0 20px' }}>
          <div className="alert error">{error || 'Ticket not found'}</div>
          <p className="text-muted text-sm">
            Check your tracking token or contact support.
          </p>
        </div>
      </div>
    );
  }

  const priorityColors: Record<string, string> = {
    URGENT: '#991b1b', MEDIUM: '#92400e', LOW: '#166534',
  };

  return (
    <div style={{ minHeight: '100vh', background: '#f8f9fa' }}>
      {/* Header */}
      <div style={{ background: '#1e293b', padding: '12px 20px', color: 'white' }}>
        <div style={{ maxWidth: 700, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontWeight: 700, fontSize: 16 }}>🎫 Frontdesk</span>
          <span style={{ color: '#94a3b8', fontSize: 13 }}>Arvo Systems Support</span>
        </div>
      </div>

      <div style={{ maxWidth: 700, margin: '0 auto', padding: '20px 16px' }}>
        {/* Ticket header */}
        <div className="card mb-12">
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <div>
              <h1 style={{ fontSize: 18, marginBottom: 6 }}>{ticket.subject}</h1>
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                Token: <code>{ticket.tracking_token}</code>
              </span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span
                style={{
                  display: 'inline-block',
                  padding: '3px 10px',
                  borderRadius: 100,
                  fontSize: 12,
                  fontWeight: 600,
                  background: statusColors[ticket.status] + '22',
                  color: statusColors[ticket.status],
                  marginBottom: 4,
                }}
              >
                {ticket.status.replace('_', ' ')}
              </span>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>
                Priority:{' '}
                <span style={{ color: priorityColors[ticket.priority], fontWeight: 600 }}>
                  {ticket.priority}
                </span>
              </div>
            </div>
          </div>

          {ticket.status === 'WAITING_ON_CUSTOMER' && (
            <div className="alert info">
              💬 We're waiting for your reply to continue working on this ticket.
            </div>
          )}

          {ticket.status === 'RESOLVED' && (
            <div className="alert success">
              ✅ This ticket has been resolved. If your issue persists, you can reopen it within 7 days.
            </div>
          )}

          {ticket.status === 'CLOSED' && (
            <div className="alert info">
              🔒 This ticket is closed. Reply below to create a new linked ticket.
            </div>
          )}
        </div>

        {/* Thread */}
        <div className="thread">
          <div className="message customer">
            <div className="message-header">
              <span className="message-author">{ticket.customer_name}</span>
              <span className="text-sm text-muted">{formatDate(ticket.created_at)}</span>
            </div>
            <div className="message-body">{ticket.description}</div>
          </div>

          {messages.map(m => (
            <div
              key={m.id}
              className={`message ${m.author_type === 'CUSTOMER' ? 'customer' : 'agent-public'}`}
            >
              <div className="message-header">
                <span className="message-author">
                  {m.author_name ?? (m.author_type === 'CUSTOMER' ? ticket.customer_name : 'Arvo Systems Support')}
                </span>
                {m.author_type !== 'CUSTOMER' && (
                  <span style={{ fontSize: 11, color: '#065f46', background: '#d1fae5', padding: '1px 6px', borderRadius: 100 }}>
                    Support Team
                  </span>
                )}
                <span className="message-time">{formatDate(m.created_at)}</span>
              </div>
              <div className="message-body">{m.body}</div>
            </div>
          ))}
        </div>

        {/* Reply / Reopen */}
        <div className="card mt-16">
          {replyOk && <div className="alert success mb-8">{replyOk}</div>}
          {replyError && <div className="alert error mb-8">{replyError}</div>}

          {ticket.status === 'RESOLVED' ? (
            <>
              <p className="text-sm text-muted mb-8">
                Still having issues? You can reopen this ticket within 7 days of resolution.
              </p>
              <button className="primary" onClick={reopen}>Reopen Ticket</button>
            </>
          ) : (
            <>
              <label className="mb-8" style={{ display: 'block' }}>
                {ticket.status === 'CLOSED'
                  ? 'Reply (a new linked ticket will be created)'
                  : 'Reply to this ticket'}
              </label>
              <textarea
                value={reply}
                onChange={e => setReply(e.target.value)}
                placeholder="Type your reply..."
                rows={4}
              />
              <button
                className="primary mt-8"
                onClick={sendReply}
                disabled={sending || !reply.trim()}
              >
                {sending ? 'Sending...' : 'Send Reply'}
              </button>
            </>
          )}
        </div>

        <div className="text-sm text-muted mt-16" style={{ textAlign: 'center' }}>
          Powered by Frontdesk · Arvo Systems Support
        </div>
      </div>
    </div>
  );
}
