import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import { getPool } from './pool';
import { addWorkingMinutes } from '../domain/workingTime';
import { WORKING_HOURS, SLA_TARGETS, Priority } from '../config/constants';
import { appendEvent } from '../domain/sla';

const noHolidays = async () => new Set<string>();

async function ist(dateStr: string): Promise<Date> {
  return new Date(dateStr.replace(' ', 'T') + '+05:30');
}

export async function seed(pool: Pool): Promise<void> {
  console.log('[seed] Starting idempotent seed...');

  // Clear existing seed data (by email pattern)
  await pool.query(`DELETE FROM ticket_events`);
  await pool.query(`DELETE FROM messages`);
  await pool.query(`DELETE FROM tickets`);
  await pool.query(`DELETE FROM holidays`);
  await pool.query(`DELETE FROM users`);

  // ── Users ─────────────────────────────────────────────────
  const hash = (pw: string) => bcrypt.hash(pw, 10);

  const users = [
    { name: 'Priya Sharma',   email: 'priya@arvo.example',   role: 'MANAGER', pw: 'manager123' },
    { name: 'Anita Patel',    email: 'anita@arvo.example',    role: 'AGENT',   pw: 'agent123' },
    { name: 'Ravi Kumar',     email: 'ravi@arvo.example',     role: 'AGENT',   pw: 'agent123' },
    { name: 'Suresh Nair',    email: 'suresh@arvo.example',   role: 'AGENT',   pw: 'agent123' },
    { name: 'Deepa Menon',    email: 'deepa@arvo.example',    role: 'AGENT',   pw: 'agent123' },
    { name: 'Vikram Joshi',   email: 'vikram@arvo.example',   role: 'AGENT',   pw: 'agent123' },
    { name: 'Kavya Reddy',    email: 'kavya@arvo.example',    role: 'AGENT',   pw: 'agent123' },
    { name: 'Amit Singh',     email: 'amit@arvo.example',     role: 'AGENT',   pw: 'agent123' },
    { name: 'Neha Gupta',     email: 'neha@arvo.example',     role: 'AGENT',   pw: 'agent123' },
  ];

  const userIds: Record<string, string> = {};
  for (const u of users) {
    const passwordHash = await hash(u.pw);
    const r = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [u.name, u.email, passwordHash, u.role]
    );
    userIds[u.email] = r.rows[0].id;
  }

  console.log('[seed] Created 9 users (1 manager, 8 agents)');

  // ── Holidays ──────────────────────────────────────────────
  // NOTE: These are placeholder Indian public holidays for 2026.
  //       Review and update this list each year.
  const holidays = [
    { date: '2026-01-26', name: 'Republic Day' },
    { date: '2026-05-01', name: 'Labour Day' },
    { date: '2026-08-15', name: 'Independence Day' },
    { date: '2026-10-02', name: 'Gandhi Jayanti' },
    { date: '2026-12-25', name: 'Christmas Day' },
    { date: '2026-11-04', name: 'Diwali (placeholder)' },
  ];
  for (const h of holidays) {
    await pool.query(
      `INSERT INTO holidays (date, name) VALUES ($1, $2) ON CONFLICT (date) DO NOTHING`,
      [h.date, h.name]
    );
  }
  console.log('[seed] Created holidays');

  // ── Helper: insert ticket + events ───────────────────────
  async function createTicket(opts: {
    subject: string;
    description: string;
    customerName: string;
    customerEmail: string;
    priority: Priority;
    status: string;
    assigneeEmail?: string;
    createdAt?: string; // ISO or IST
    firstRepliedAt?: string;
    resolvedAt?: string;
    slaBreached?: boolean;
    parentTicketId?: string;
  }): Promise<string> {
    // If string has tz info ('+' offset or trailing 'Z'), parse directly.
    // Otherwise treat as bare IST datetime string.
    const createdAt = opts.createdAt
      ? (opts.createdAt.includes('+') || opts.createdAt.endsWith('Z')
          ? new Date(opts.createdAt)
          : await ist(opts.createdAt))
      : new Date();

    const assigneeId = opts.assigneeEmail ? userIds[opts.assigneeEmail] : null;

    // Compute SLA due dates
    const target = SLA_TARGETS[opts.priority];
    const responseDueAt = await addWorkingMinutes(createdAt, target.firstReplyMinutes, WORKING_HOURS, noHolidays);
    const resolutionDueAt = await addWorkingMinutes(createdAt, target.resolutionMinutes, WORKING_HOURS, noHolidays);

    const r = await pool.query(
      `INSERT INTO tickets
         (subject, description, customer_name, customer_email, priority, status, assignee_id,
          response_due_at, resolution_due_at,
          first_responded_at, first_response_sla_met,
          resolved_at, resolution_sla_met, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING id, tracking_token`,
      [
        opts.subject, opts.description, opts.customerName, opts.customerEmail,
        opts.priority, opts.status, assigneeId,
        opts.status === 'WAITING_ON_CUSTOMER' ? null : responseDueAt.toISOString(),
        opts.status === 'WAITING_ON_CUSTOMER' ? null : resolutionDueAt.toISOString(),
        opts.firstRepliedAt ? new Date(opts.firstRepliedAt).toISOString() : null,
        opts.firstRepliedAt ? (opts.slaBreached === true ? false : true) : null,
        opts.resolvedAt ? new Date(opts.resolvedAt).toISOString() : null,
        opts.resolvedAt ? (opts.slaBreached === true ? false : true) : null,
        createdAt.toISOString(),
      ]
    );

    const ticketId = r.rows[0].id;

    // Insert minimal events for history
    await pool.query(
      `INSERT INTO ticket_events (ticket_id, actor, event_type, details, prev_hash, hash, created_at)
       VALUES ($1, 'CUSTOMER', 'TICKET_CREATED', $2, '', encode(sha256($3::bytea), 'hex'), $4)`,
      [ticketId, JSON.stringify({ subject: opts.subject, priority: opts.priority }),
       `${ticketId}CUSTOMER TICKET_CREATED`, createdAt.toISOString()]
    );

    if (assigneeId) {
      await pool.query(
        `INSERT INTO ticket_events (ticket_id, actor, event_type, details, prev_hash, hash)
         VALUES ($1, $2, 'TICKET_CLAIMED', $3, '', encode(sha256($4::bytea), 'hex'))`,
        [ticketId, assigneeId, JSON.stringify({ assignee: assigneeId }),
         `${ticketId}${assigneeId}TICKET_CLAIMED`]
      );
    }

    return ticketId;
  }

  // ── 25 sample tickets ─────────────────────────────────────

  // 1. NEW unassigned – URGENT (should be late already)
  const t1 = await createTicket({
    subject: '[URGENT] Production API is completely down',
    description: 'All API calls returning 500. Business cannot operate. Need immediate help.',
    customerName: 'Ramesh Corp',
    customerEmail: 'ramesh@corp.example',
    priority: 'URGENT',
    status: 'NEW',
    createdAt: '2026-11-21 06:00+05:30', // Yesterday early morning
  });

  // 2. OPEN assigned – URGENT – LATE (SLA breached)
  const t2 = await createTicket({
    subject: 'Cannot login to admin portal',
    description: 'All 3 admins locked out. Critical operations blocked.',
    customerName: 'Infra Ltd',
    customerEmail: 'admin@infra.example',
    priority: 'URGENT',
    status: 'OPEN',
    assigneeEmail: 'ravi@arvo.example',
    createdAt: '2026-11-20 09:30+05:30',
    slaBreached: true,
  });

  // 3. OPEN – MEDIUM – normal
  const t3 = await createTicket({
    subject: 'Dashboard not loading for some users',
    description: 'About 20% of users seeing blank dashboard.',
    customerName: 'StarTech',
    customerEmail: 'it@startech.example',
    priority: 'MEDIUM',
    status: 'OPEN',
    assigneeEmail: 'anita@arvo.example',
    createdAt: '2026-11-21 10:00+05:30',
  });

  // 4. WAITING_ON_CUSTOMER
  const t4 = await createTicket({
    subject: 'Export feature produces empty CSV',
    description: 'Tried multiple times. The CSV download is always empty.',
    customerName: 'DataCo',
    customerEmail: 'ops@dataco.example',
    priority: 'MEDIUM',
    status: 'WAITING_ON_CUSTOMER',
    assigneeEmail: 'suresh@arvo.example',
    createdAt: '2026-11-19 14:00+05:30',
  });

  // 5. WAITING_ON_CUSTOMER near auto-close (created 4.9 days ago)
  const nearAutoCloseDate = new Date(Date.now() - 4.9 * 24 * 60 * 60 * 1000);
  const t5 = await createTicket({
    subject: 'Integration webhook not firing',
    description: 'Our Slack integration is broken. No webhooks are reaching us.',
    customerName: 'SlackFan Inc',
    customerEmail: 'dev@slackfan.example',
    priority: 'MEDIUM',
    status: 'WAITING_ON_CUSTOMER',
    assigneeEmail: 'deepa@arvo.example',
    createdAt: nearAutoCloseDate.toISOString(),
  });

  // 6. RESOLVED – within 7-day reopen window (resolved yesterday)
  const resolvedYesterday = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
  const t6 = await createTicket({
    subject: 'Password reset email not sending',
    description: 'Users cannot reset passwords.',
    customerName: 'BizSoft',
    customerEmail: 'support@bizsoft.example',
    priority: 'MEDIUM',
    status: 'RESOLVED',
    assigneeEmail: 'vikram@arvo.example',
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    firstRepliedAt: new Date(Date.now() - 2.5 * 24 * 60 * 60 * 1000).toISOString(),
    resolvedAt: resolvedYesterday.toISOString(),
  });

  // 7. RESOLVED near reopen deadline (resolved 6 days ago)
  const resolvedSixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
  const t7 = await createTicket({
    subject: 'Mobile app crash on iOS 17',
    description: 'All iOS 17 users experience crash on launch.',
    customerName: 'MobileTech',
    customerEmail: 'cto@mobiletech.example',
    priority: 'URGENT',
    status: 'RESOLVED',
    assigneeEmail: 'kavya@arvo.example',
    createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    firstRepliedAt: new Date(Date.now() - 7.5 * 24 * 60 * 60 * 1000).toISOString(),
    resolvedAt: resolvedSixDaysAgo.toISOString(),
  });

  // 8. CLOSED
  const t8 = await createTicket({
    subject: 'Billing invoice discrepancy',
    description: 'Last month invoice shows double charge.',
    customerName: 'Accounts Co',
    customerEmail: 'accounts@co.example',
    priority: 'LOW',
    status: 'CLOSED',
    assigneeEmail: 'amit@arvo.example',
    createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
    firstRepliedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    resolvedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  });

  // 9-25: Mix of tickets
  const scenarios = [
    { subject: 'Report generation timeout', priority: 'MEDIUM' as Priority, status: 'OPEN', assigneeEmail: 'neha@arvo.example' },
    { subject: 'Two-factor auth not working', priority: 'URGENT' as Priority, status: 'OPEN', assigneeEmail: 'anita@arvo.example' },
    { subject: 'API rate limit hit unexpectedly', priority: 'MEDIUM' as Priority, status: 'NEW' },
    { subject: 'PDF export formatting broken', priority: 'LOW' as Priority, status: 'OPEN', assigneeEmail: 'ravi@arvo.example' },
    { subject: 'User import CSV parser rejects valid file', priority: 'MEDIUM' as Priority, status: 'WAITING_ON_CUSTOMER', assigneeEmail: 'suresh@arvo.example' },
    { subject: 'SSO SAML configuration help', priority: 'LOW' as Priority, status: 'OPEN', assigneeEmail: 'deepa@arvo.example' },
    { subject: 'Notification emails going to spam', priority: 'LOW' as Priority, status: 'RESOLVED', assigneeEmail: 'vikram@arvo.example', resolvedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() },
    { subject: 'Database connection pool exhausted', priority: 'URGENT' as Priority, status: 'OPEN', assigneeEmail: 'kavya@arvo.example' },
    { subject: 'Audit log export missing entries', priority: 'MEDIUM' as Priority, status: 'OPEN', assigneeEmail: 'amit@arvo.example' },
    { subject: 'Webhook retry policy clarification', priority: 'LOW' as Priority, status: 'CLOSED' },
    { subject: 'Custom domain SSL certificate expired', priority: 'URGENT' as Priority, status: 'RESOLVED', assigneeEmail: 'neha@arvo.example', resolvedAt: new Date().toISOString() },
    { subject: 'Bulk delete operation slow', priority: 'LOW' as Priority, status: 'NEW' },
    { subject: 'Role permissions not applying correctly', priority: 'MEDIUM' as Priority, status: 'OPEN', assigneeEmail: 'anita@arvo.example' },
    { subject: 'Graph widget rendering blank', priority: 'LOW' as Priority, status: 'OPEN', assigneeEmail: 'ravi@arvo.example' },
    { subject: 'API docs link returns 404', priority: 'LOW' as Priority, status: 'RESOLVED', resolvedAt: new Date().toISOString() },
    { subject: 'Timezone offset wrong in reports', priority: 'MEDIUM' as Priority, status: 'OPEN', assigneeEmail: 'suresh@arvo.example' },
    { subject: 'CI/CD webhook integration failing', priority: 'MEDIUM' as Priority, status: 'NEW' },
  ];

  for (const s of scenarios) {
    await createTicket({
      subject: s.subject,
      description: `Customer reported: ${s.subject}. Please investigate.`,
      customerName: 'Customer',
      customerEmail: 'customer@example.com',
      priority: s.priority,
      status: s.status,
      assigneeEmail: (s as { assigneeEmail?: string }).assigneeEmail,
      firstRepliedAt: s.status !== 'NEW' ? new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() : undefined,
      resolvedAt: (s as { resolvedAt?: string }).resolvedAt,
    });
  }

  // Add some messages to key tickets
  await pool.query(
    `INSERT INTO messages (ticket_id, author_type, author_id, visibility, body)
     VALUES ($1, 'AGENT', $2, 'PUBLIC', 'Thank you for contacting Arvo Systems support. We are investigating the issue and will update you shortly.'),
            ($1, 'AGENT', $2, 'INTERNAL', 'Internal: Check server logs at /var/log/api.log - seems to be a connection pool issue.')`,
    [t3, userIds['anita@arvo.example']]
  );

  await pool.query(
    `INSERT INTO messages (ticket_id, author_type, visibility, body)
     VALUES ($1, 'CUSTOMER', 'PUBLIC', 'Any update? This is blocking 5 of our team members.')`,
    [t3]
  );

  console.log('[seed] Created ~25 sample tickets');
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('DEMO CREDENTIALS:');
  console.log('  Manager: priya@arvo.example / manager123');
  console.log('  Agent:   anita@arvo.example / agent123');
  console.log('  Agent:   ravi@arvo.example  / agent123');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// Run if called directly (via ts-node or compiled)
// Use seed-runner.ts for direct invocation
