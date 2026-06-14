-- =============================================================================
-- Fix infinite recursion in RLS policies.
-- =============================================================================
-- All SELECT policies used a subquery like:
--   exists (select 1 from nota_games.session_participants where ... player_id = auth.uid())
--
-- When ANY of these policies evaluates, Postgres also applies the RLS policy for
-- session_participants. The session_participants policy does the same subquery on
-- itself → infinite recursion (error 42P17).
--
-- Fix: wrap the membership check in a SECURITY DEFINER function.
-- SECURITY DEFINER runs as the function owner (postgres), which bypasses RLS.
-- The function is the only place that reads session_participants without RLS;
-- it is restricted to checking only (session_id, auth.uid()) so it cannot
-- be abused to exfiltrate other data.
-- =============================================================================

create or replace function nota_games.is_participant(p_session_id uuid)
returns boolean
language sql
security definer
stable
set search_path = nota_games, public
as $$
  select exists (
    select 1 from nota_games.session_participants
    where session_id = p_session_id
      and player_id  = auth.uid()
  );
$$;

grant execute on function nota_games.is_participant to authenticated;

-- ── Rebuild session_participants SELECT policy ─────────────────────────────
drop policy if exists "participants can read their session roster"
  on nota_games.session_participants;

create policy "participants can read their session roster"
  on nota_games.session_participants for select
  to authenticated
  using (nota_games.is_participant(session_id));

-- ── Rebuild sessions SELECT policy ────────────────────────────────────────
drop policy if exists "participants can read their session"
  on nota_games.sessions;

create policy "participants can read their session"
  on nota_games.sessions for select
  to authenticated
  using (nota_games.is_participant(id));

-- ── Rebuild teams SELECT policy ───────────────────────────────────────────
drop policy if exists "participants can read teams in their session"
  on nota_games.teams;

create policy "participants can read teams in their session"
  on nota_games.teams for select
  to authenticated
  using (nota_games.is_participant(session_id));

-- ── Rebuild duos SELECT policy ────────────────────────────────────────────
drop policy if exists "participants can read duos in their session"
  on nota_games.duos;

create policy "participants can read duos in their session"
  on nota_games.duos for select
  to authenticated
  using (nota_games.is_participant(session_id));

-- ── Rebuild session_results SELECT policy ─────────────────────────────────
drop policy if exists "participants can read results in their session"
  on nota_games.session_results;

create policy "participants can read results in their session"
  on nota_games.session_results for select
  to authenticated
  using (nota_games.is_participant(session_id));

-- ── Rebuild game_events SELECT policy ─────────────────────────────────────
drop policy if exists "participants can read session events"
  on nota_games.game_events;

create policy "participants can read session events"
  on nota_games.game_events for select
  to authenticated
  using (nota_games.is_participant(session_id));
