import type { Request, Response, NextFunction } from 'express';
import { supabase } from '../../lib/supabase.js';

// Extend Express Request with the authenticated user and the raw JWT.
// Both are set unconditionally by requireAuth before any handler runs,
// so they are declared as non-optional — handlers behind requireAuth can
// access req.user and req.jwt without null checks.
declare global {
  namespace Express {
    interface Request {
      user: import('@supabase/supabase-js').User;
      jwt:  string;
    }
  }
}

/**
 * Express middleware that validates the `Authorization: Bearer <token>`
 * header against Supabase Auth, then attaches:
 *   req.user — the resolved Supabase User object
 *   req.jwt  — the raw Bearer token, for passing to supabaseForUser()
 *
 * Mount on a router with `router.use(requireAuth)` or as per-route middleware.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    res.status(401).json({ error: 'Unauthorised' });
    return;
  }

  req.user = user;
  req.jwt  = token;
  next();
}
