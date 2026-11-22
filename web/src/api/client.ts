// API client utilities

const API_BASE = '/api';

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  status: number;
}

async function fetchAPI<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const contentType = res.headers.get('content-type') ?? '';
  let data: T | undefined;
  let error: string | undefined;

  if (contentType.includes('application/json')) {
    const json = await res.json();
    if (res.ok) {
      data = json as T;
    } else {
      error = (json as { error?: string }).error ?? 'Request failed';
    }
  } else if (!res.ok) {
    error = res.statusText;
  }

  return { data, error, status: res.status };
}

export const api = {
  get: <T>(path: string) => fetchAPI<T>(path),
  post: <T>(path: string, body: unknown) =>
    fetchAPI<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    fetchAPI<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => fetchAPI<T>(path, { method: 'DELETE' }),
};

// Auth
export function getStoredToken(): string | null {
  return localStorage.getItem('token');
}

export function setStoredToken(token: string | null): void {
  if (token) localStorage.setItem('token', token);
  else localStorage.removeItem('token');
}

export function getStoredUser(): AuthUser | null {
  const raw = localStorage.getItem('user');
  return raw ? JSON.parse(raw) as AuthUser : null;
}

export function setStoredUser(user: AuthUser | null): void {
  if (user) localStorage.setItem('user', JSON.stringify(user));
  else localStorage.removeItem('user');
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'AGENT' | 'MANAGER';
}

// Types
export interface Ticket {
  id: string;
  tracking_token: string;
  subject: string;
  description: string;
  customer_name: string;
  customer_email: string;
  priority: 'URGENT' | 'MEDIUM' | 'LOW';
  status: 'NEW' | 'OPEN' | 'WAITING_ON_CUSTOMER' | 'RESOLVED' | 'CLOSED';
  assignee_id: string | null;
  assignee_name: string | null;
  version: number;
  response_due_at: string | null;
  resolution_due_at: string | null;
  first_responded_at: string | null;
  first_response_sla_met: boolean | null;
  resolved_at: string | null;
  resolution_sla_met: boolean | null;
  created_at: string;
  updated_at: string;
  parent_ticket_id: string | null;
  is_late: boolean;
  is_due_soon: boolean;
}

export interface Message {
  id: string;
  ticket_id: string;
  author_type: 'AGENT' | 'CUSTOMER' | 'SYSTEM';
  author_id: string | null;
  author_name: string | null;
  visibility: 'PUBLIC' | 'INTERNAL';
  body: string;
  created_at: string;
}

export interface TicketEvent {
  id: string;
  ticket_id: string;
  actor: string;
  actor_name: string | null;
  event_type: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface SlaState {
  firstResponseElapsedMinutes: number;
  resolutionElapsedMinutes: number;
  isFirstResponseDone: boolean;
  isResolutionDone: boolean;
  isPaused: boolean;
}

// Format helpers
export function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

export function remainingMinutes(dueAt: string | null): number | null {
  if (!dueAt) return null;
  const diff = new Date(dueAt).getTime() - Date.now();
  return Math.floor(diff / 60000);
}
