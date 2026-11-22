import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, formatDate } from '../api/client';
import { useAuth } from '../components/AuthContext';

interface LateTicket {
  id: string;
  subject: string;
  priority: string;
  status: string;
  customer_name: string;
  created_at: string;
  resolved_at: string | null;
  first_response_sla_met: boolean | null;
  resolution_sla_met: boolean | null;
  assignee_name: string | null;
  is_late: boolean;
}

interface Holiday {
  id: number;
  date: string;
  name: string;
}

export default function ManagerReport() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [lateTickets, setLateTickets] = useState<LateTicket[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newHoliday, setNewHoliday] = useState({ date: '', name: '' });

  useEffect(() => {
    if (user?.role !== 'MANAGER') {
      navigate('/');
      return;
    }
    load();
  }, []);

  const load = async () => {
    setLoading(true);
    const [lateRes, holRes] = await Promise.all([
      api.get<LateTicket[]>('/manager/late-tickets'),
      api.get<Holiday[]>('/manager/holidays'),
    ]);
    if (lateRes.data) setLateTickets(lateRes.data);
    if (holRes.data) setHolidays(holRes.data);
    if (lateRes.error) setError(lateRes.error);
    setLoading(false);
  };

  const addHoliday = async () => {
    if (!newHoliday.date || !newHoliday.name) return;
    await api.post('/manager/holidays', newHoliday);
    setNewHoliday({ date: '', name: '' });
    await load();
  };

  const deleteHoliday = async (id: number) => {
    await api.delete(`/manager/holidays/${id}`);
    await load();
  };

  const exportCSV = () => {
    window.open('/api/manager/export/csv', '_blank');
  };

  return (
    <div className="layout">
      <nav className="nav">
        <span className="brand">🎫 <span>Frontdesk</span></span>
        <button onClick={() => navigate('/')} style={{ fontSize: '12px', padding: '4px 10px' }}>← Dashboard</button>
        <div className="spacer" />
        <span className="user-info">{user?.name} (Manager)</span>
        <button onClick={logout} style={{ fontSize: '12px', padding: '4px 10px' }}>Logout</button>
      </nav>

      <div className="container">
        <div className="flex gap-12 mb-16" style={{ alignItems: 'center' }}>
          <h2 style={{ fontSize: '18px' }}>Manager Report</h2>
          <div className="spacer" />
          <button className="primary" onClick={exportCSV}>⬇ Export CSV</button>
        </div>

        {error && <div className="alert error">{error}</div>}

        {/* Late Tickets */}
        <div className="card mb-16">
          <h3 style={{ marginBottom: 12 }}>🔴 Late Tickets ({lateTickets.length})</h3>
          {loading ? (
            <div className="text-muted text-sm">Loading...</div>
          ) : lateTickets.length === 0 ? (
            <div className="text-muted text-sm">No late tickets! 🎉</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th>Assignee</th>
                  <th>First Reply SLA</th>
                  <th>Resolution SLA</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {lateTickets.map(t => (
                  <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/tickets/${t.id}`)}>
                    <td>
                      <div className="font-medium">{t.subject}</div>
                      <div className="text-sm text-muted">#{t.id.slice(0, 8)}</div>
                    </td>
                    <td><span className={`badge ${t.priority.toLowerCase()}`}>{t.priority}</span></td>
                    <td><span className="badge">{t.status}</span></td>
                    <td>{t.assignee_name ?? '—'}</td>
                    <td>
                      {t.first_response_sla_met === null
                        ? <span className="badge late">⏳ Pending</span>
                        : t.first_response_sla_met
                        ? <span className="badge open">✅ Met</span>
                        : <span className="badge late">❌ Breached</span>}
                    </td>
                    <td>
                      {t.resolution_sla_met === null
                        ? <span className="badge late">⏳ Pending</span>
                        : t.resolution_sla_met
                        ? <span className="badge open">✅ Met</span>
                        : <span className="badge late">❌ Breached</span>}
                    </td>
                    <td className="text-sm">{formatDate(t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Holidays Management */}
        <div className="card">
          <h3 style={{ marginBottom: 4 }}>📅 Holidays</h3>
          <p className="text-sm text-muted mb-12">
            These holidays are excluded from SLA working time calculations.
          </p>

          <div className="flex gap-8 mb-12" style={{ flexWrap: 'wrap' }}>
            <input
              type="date"
              value={newHoliday.date}
              onChange={e => setNewHoliday(h => ({ ...h, date: e.target.value }))}
              style={{ width: 160 }}
            />
            <input
              type="text"
              placeholder="Holiday name"
              value={newHoliday.name}
              onChange={e => setNewHoliday(h => ({ ...h, name: e.target.value }))}
              style={{ flex: 1, minWidth: 200 }}
            />
            <button className="primary" onClick={addHoliday}>Add Holiday</button>
          </div>

          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Name</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {holidays.map(h => (
                <tr key={h.id}>
                  <td>{h.date}</td>
                  <td>{h.name}</td>
                  <td>
                    <button
                      className="danger"
                      style={{ fontSize: '11px', padding: '2px 8px' }}
                      onClick={() => deleteHoliday(h.id)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
