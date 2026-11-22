import { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ??
  'postgresql://frontdesk_test:frontdesk_test@localhost:5432/frontdesk_test';
process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

let pool: Pool | null = null;

export async function getTestPool(): Promise<Pool> {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await runMigrations(pool);
  }
  return pool;
}

export async function cleanDB(pool: Pool): Promise<void> {
  // Order matters for FK constraints
  await pool.query('DELETE FROM ticket_events');
  await pool.query('DELETE FROM messages');
  await pool.query('DELETE FROM tickets');
  await pool.query('DELETE FROM holidays');
  await pool.query('DELETE FROM users WHERE email NOT LIKE \'%@test.example%\'');
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
