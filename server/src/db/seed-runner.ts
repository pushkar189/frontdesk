// Re-export seed for dist/db/seed.js path
export { seed } from './seed';

import { getPool } from './pool';
import { seed } from './seed';

const pool = getPool();
seed(pool)
  .then(() => { console.log('[seed] Done'); process.exit(0); })
  .catch((err) => { console.error('[seed] Error:', err); process.exit(1); });
