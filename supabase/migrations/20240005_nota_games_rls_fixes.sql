-- ─── Fix #1: tighten sessions SELECT predicate ────────────────────────────────
-- Old policy used `using (true)` — any authenticated user could read any session.
-- Replace with a subquery scoped to sessions the player is registered in.

drop policy if exists "authenticated users can read sessions" on nota_games.sessions;

create policy "participants can read their session"
  on nota_games.sessions for select
  to authenticated
  using (
    exists (
      select 1 from nota_games.session_participants sp
      where sp.session_id = sessions.id
        and sp.player_id  = auth.uid()
    )
  );

-- ─── Fix #6: game_events SELECT policy ───────────────────────────────────────
-- Table was created in 20240004 with no RLS policies.
-- Authenticated users can read events from sessions they are registered in.
-- Guard: this policy was found to already exist in the hosted DB (applied manually
-- before this migration was written). Drop-if-exists makes this idempotent.

drop policy if exists "participants can read session events" on nota_games.game_events;

create policy "participants can read session events"
  on nota_games.game_events for select
  to authenticated
  using (
    exists (
      select 1 from nota_games.session_participants sp
      where sp.session_id = game_events.session_id
        and sp.player_id  = auth.uid()
    )
  );

-- ─── Fix #7: drop authenticated UPDATE on sessions ───────────────────────────
-- Sessions are immutable after creation — only status transitions are allowed,
-- and those run via the service role client in PATCH /dashboard/sessions/:id/state.
-- No authenticated user should be able to UPDATE any session row directly.

drop policy if exists "creator can update their session" on nota_games.sessions;

-- Explicit block for safety: deny UPDATE for authenticated role entirely.
-- Service role bypasses RLS so this does not affect the Game Engine.
create policy "authenticated users cannot update sessions"
  on nota_games.sessions for update
  to authenticated
  using (false);

-- ─── Fix #8: tighten participant self-insert ──────────────────────────────────
-- Players can confirm themselves into a session via the app, BUT only while
-- the session is still pending. Joining an active, paused, or ended session
-- is not allowed — the instructor must have pre-assigned them before start.

drop policy if exists "players can join a session" on nota_games.session_participants;

create policy "players can confirm into a pending session"
  on nota_games.session_participants for insert
  to authenticated
  with check (
    player_id = auth.uid()
    and exists (
      select 1 from nota_games.sessions s
      where s.id     = session_id
        and s.status = 'pending'
    )
  );

-- ─── Explicit INSERT block on sessions for authenticated users ────────────────
-- Only service role can create sessions (via POST /dashboard/sessions).
-- Authenticated users have no INSERT policy so RLS blocks it implicitly,
-- but this makes the intent explicit and audit-visible.

create policy "authenticated users cannot insert sessions"
  on nota_games.sessions for insert
  to authenticated
  with check (false);
