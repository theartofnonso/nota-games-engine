import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL     = process.env['SUPABASE_URL'];
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const ANON_KEY         = process.env['SUPABASE_ANON_KEY'];

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  throw new Error(
    'Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY',
  );
}

// ── Service role client ───────────────────────────────────────────────────────
// Bypasses RLS. Use ONLY in the Game Engine (motion-subscriber.ts) for:
//   • upsert_score RPC calls
//   • game_events inserts
//   • Realtime channel management (channel(), subscribe(), send())
// NEVER pass this client into a request handler that acts on behalf of a user.
export const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── User-scoped client factory ────────────────────────────────────────────────
// Creates a client that forwards the caller's JWT so Postgres RLS applies.
// Use in all route handlers for any SELECT / RPC read that a player or
// instructor should be authorised to perform.
// Pass req.jwt (attached by the requireAuth middleware).
export function supabaseForUser(jwt: string) {
  return createClient(SUPABASE_URL!, ANON_KEY!, {
    auth:   { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}
