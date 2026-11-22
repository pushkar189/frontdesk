import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, AuthUser } from '../api/client';
import { useAuth } from '../components/AuthContext';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const res = await api.post<{ token: string; user: AuthUser }>('/auth/login', { email, password });

    if (res.error || !res.data) {
      setError(res.error ?? 'Login failed');
    } else {
      login(res.data.user, res.data.token);
      navigate('/');
    }

    setLoading(false);
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>🎫 Frontdesk</h1>
        <p>Arvo Systems Support Portal</p>

        {error && <div className="alert error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="agent@arvo.example"
              required
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>
          <button type="submit" className="primary" style={{ width: '100%' }} disabled={loading}>
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <div className="mt-16 text-sm text-muted">
          <strong>Demo logins:</strong><br />
          Manager: priya@arvo.example / manager123<br />
          Agent: anita@arvo.example / agent123
        </div>
      </div>
    </div>
  );
}
