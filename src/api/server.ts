import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import logger from '../lib/logger.js';
import { sessionsRouter } from './routes/sessions.js';
import { dashboardRouter } from './routes/dashboard.js';

export function createServer() {
  const app = express();

  app.use(pinoHttp({ logger }));
  app.use(cors());
  app.use(express.json({ limit: '256kb' })); // 5s batch at 20Hz ≈ 2–4kb; 256kb is generous

  // Player-facing endpoints (join, motion, leave)
  app.use('/sessions', sessionsRouter);

  // Dashboard / instructor endpoints (create session, add participants, update state, leaderboard)
  // Separate prefix keeps player routes (/sessions/...) and instructor routes
  // (/dashboard/sessions/...) unambiguous at the HTTP level.
  app.use('/dashboard/sessions', dashboardRouter);

  app.get('/health', (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  return app;
}
