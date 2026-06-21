import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../../lib/supabase.js';
import { validate } from '../middleware/validate.js';
import logger from '../../lib/logger.js';

export const authRouter = Router();

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
// Returns a Supabase JWT for use with all dashboard endpoints.

authRouter.post(
  '/login',
  validate(LoginSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { email, password } = req.body as z.infer<typeof LoginSchema>;

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.session) {
      logger.warn({ email, err: error?.message }, 'login failed');
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    logger.info({ userId: data.user.id, email }, 'instructor logged in');

    res.status(200).json({
      accessToken: data.session.access_token,
      expiresAt:   data.session.expires_at,
      user: {
        id:    data.user.id,
        email: data.user.email,
      },
    });
  },
);
