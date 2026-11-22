import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  api, Ticket, formatDate, remainingMinutes, formatMinutes
} from '../api/client';
import { useAuth } from '../components/AuthContext';

function PriorityBadge({ p }: { p: string }) {
  return <span className={`badge ${p.toLowerCase()}`}>{p}</span>;
}

function StatusBadge({ s }: { s: string }) {
  const cls = s === 'WAITING_ON_CUSTOMER' ? 'waiting' : s.toLowerCase().replace('_', '-');
  const label = s === 'WAITING_ON_CUSTOMER' ? 'WAITING' : s;
  return <span className={`badge ${cls}`}>{label}</span>;
}

function SlaInfo({ ticket }: { ticket: Ticket }) {
  if (ticket.status === 'CLOSED' || ticket.status === 'RESOLVED') return null;
  if (ticket.status === 'WAITING_ON_CUSTOMER') {
    return <span className="badge paused">⏸ PAUSED</span>;
  }

  const dueAt = ticket.first_responded_at ? ticket.resolution_due_at : ticket.response_due_at;
  if (!dueAt) return null;

  const rem = remainingMinutes(dueAt);
  if (rem === null) return null;

  if (rem < 0) {
    return <span className="badge late">🔴 LATE {formatMinutes(-rem)} ago</span>;
  }
  if (rem < 30) {
    return <span className="badge due-soon">⚠️ DUE {formatMinutes(rem)}</span>;
  }
  return <span className="text-sm text-muted">Due in {formatMinutes(rem)}</span>;
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [view, setView] = useState('mine');

  const loadTickets = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), view });
    if (statusFilter) params.set('status', statusFilter);
    if (priorityFilter) params.set('priority', priorityFilter);

    const res = await api.get<{ tickets: Ticket[]; pagination: { total: number } }>(
      `/tickets?${params}`
    );
    if (res.data) {
      setTickets(res.data.tickets);
      setTotal(res.data.pagination.total);
      setError('');
    } else {
      setError(res.error ?? 'Failed to load tickets');
    }
    setLoading(false);
  }, [page, statusFilter, priorityFilter, view]);

  useEffect(() => { loadTickets(); }, [loadTickets]);
  // Refresh every 30 seconds
  useEffect(() => {
    const id = setInterval(loadTickets, 30000);
    return () => clearInterval(id);
  }, [loadTickets]);

  const lateCount = tickets.filter(t => t.is_late).length;

  return (
    <div className="layout">
      <nav className="nav">
        <span className="brand">🎫 <span>Frontdesk</span></span>
        <span className="text-sm" style={{ color: '#94a3b8' }}>Arvo Systems</span>
        <div className="spacer" />
        {user?.role === 'MANAGER' && (
          <a href="/manager" onClick={e => { e.preventDefault(); navigate('/manager'); }}>
            Manager Report
          </a>
        )}
        <span className="user-info">{user?.name} ({user?.role})</span>
        <button onClick={logout} style={{ fontSize: '12px', padding: '4px 10px' }}>Logout</button>
      </nav>

      <div className="container">
        <div className="flex gap-12 mb-12" style={{ alignItems: 'center' }}>
          <h2 style={{ fontSize: '18px' }}>
            {view === 'mine' ? 'My Queue' : 'All Tickets'}
          </h2>
          {lateCount > 0 && (
            <span className="badge late">🔴 {lateCount} LATE</span>
          )}
          <div className="spacer" />
          <button onClick={loadTickets}>↻ Refresh</button>
        </div>

        <div className="filters">
          {user?.role === 'MANAGER' && (
            <select value={view} onChange={e => { setView(e.target.value); setPage(1); }}>
              <option value="mine">My Queue</option>
              <option value="all">All Tickets</option>
            </select>
          )}
          <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }}>
            <option value="">All Statuses</option>
            <option value="NEW">New</option>
            <option value="OPEN">Open</option>
            <option value="WAITING_ON_CUSTOMER">Waiting on Customer</option>
            <option value="RESOLVED">Resolved</option>
            <option value="CLOSED">Closed</option>
          </select>
          <select value={priorityFilter} onChange={e => { setPriorityFilter(e.target.value); setPage(1); }}>
            <option value="">All Priorities</option>
            <option value="URGENT">Urgent</option>
            <option value="MEDIUM">Medium</option>
            <option value="LOW">Low</option>
          </select>
          {(statusFilter || priorityFilter) && (
            <button onClick={() => { setStatusFilter(''); setPriorityFilter(''); setPage(1); }}>
              Clear filters
            </button>
          )}
        </div>

        {error && <div className="alert error">{error}</div>}

        {loading ? (
          <div className="text-muted text-sm">Loading...</div>
        ) : tickets.length === 0 ? (
          <div className="card">
            <div className="text-muted text-sm">No tickets found.</div>
          </div>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            {tickets.map(ticket => (
              <div
                key={ticket.id}
                className={`ticket-item ${ticket.is_late ? 'late-row' : ''}`}
                onClick={() => navigate(`/tickets/${ticket.id}`)}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="ticket-subject" style={{ marginBottom: 4 }}>
                    {ticket.subject}
                  </div>
                  <div className="ticket-meta">
                    <PriorityBadge p={ticket.priority} />
                    <StatusBadge s={ticket.status} />
                    {ticket.is_late && <span className="badge late">🔴 LATE</span>}
                    {ticket.is_due_soon && !ticket.is_late && <span className="badge due-soon">⚠️ DUE SOON</span>}
                    <SlaInfo ticket={ticket} />
                    {ticket.assignee_name && (
                      <span className="text-sm text-muted">👤 {ticket.assignee_name}</span>
                    )}
                    {!ticket.assignee_id && (
                      <span className="badge new">Unassigned</span>
                    )}
                  </div>
                  <div className="ticket-info mt-8">
                    {ticket.customer_name} · {formatDate(ticket.created_at)}
                  </div>
                </div>
                <div className="text-sm text-muted" style={{ flexShrink: 0 }}>
                  #{ticket.id.slice(0, 8)}
                </div>
              </div>
            ))}
          </div>
        )}

        {total > 25 && (
          <div className="pagination">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>← Prev</button>
            <span className="text-sm text-muted">Page {page}</span>
            <button onClick={() => setPage(p => p + 1)} disabled={tickets.length < 25}>Next →</button>
          </div>
        )}
      </div>
    </div>
  );
}
