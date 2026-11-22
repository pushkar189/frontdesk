import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

export async function runMigrations(pool: Pool): Promise<void> {
  // Ensure migrations tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, '../../migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const existing = await pool.query(
      'SELECT filename FROM schema_migrations WHERE filename = $1',
      [file]
    );
    if (existing.rows.length > 0) {
      console.log(`[migrate] Skipping ${file} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`[migrate] Applying ${file}...`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file]
      );
      await client.query('COMMIT');
      console.log(`[migrate] Applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrate] Failed on ${file}:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log('[migrate] All migrations applied');
}
