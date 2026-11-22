import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';
import { getPool } from './db/pool';
import { runMigrations } from './db/migrate';
import { setHolidayFetcher, getHolidaysFromDB } from './domain/sla';
import { startScheduler } from './jobs/sweep';
import { errorHandler, notFound } from './middleware/errorHandler';

// Routes
import authRouter from './routes/auth';
import publicRouter from './routes/public';
import ticketsRouter from './routes/tickets';
import managerRouter from './routes/manager';
import auditRouter from './routes/audit';

const app = express();

// Trust proxy (for rate limiting behind Render/Railway)
app.set('trust proxy', 1);

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'frontdesk', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/auth', authRouter);
app.use('/api/public', publicRouter);
app.use('/api/tickets', ticketsRouter);
app.use('/api/manager', managerRouter);
app.use('/api/audit', auditRouter);

// Serve React app in production
if (process.env.NODE_ENV === 'production') {
  const webDist = path.join(__dirname, '../../web/dist');
  app.use(express.static(webDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// 404 + error handler
app.use(notFound);
app.use(errorHandler);

const PORT = parseInt(process.env.PORT ?? '3001');

async function main() {
  const pool = getPool();

  // Run migrations
  await runMigrations(pool);

  // Set up holiday fetcher for SLA calculations
  setHolidayFetcher(getHolidaysFromDB);

  // Start in-process sweep scheduler
  startScheduler();

  app.listen(PORT, () => {
    console.log(`[server] Frontdesk running on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error('[startup] Fatal error:', err);
  process.exit(1);
});

export default app;
