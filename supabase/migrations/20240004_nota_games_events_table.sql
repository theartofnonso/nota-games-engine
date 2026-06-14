-- ─── Game Events (append-only audit log) ─────────────────────────────────────
-- Records every significant occurrence during a session.
-- Append-only enforced at both the rule level and RLS level.

create table nota_games.game_events (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references nota_games.sessions(id) on delete cascade,
  player_id    uuid references auth.users(id),
  event_type   nota_games.event_type not null,
  phase        nota_games.session_phase,
  current_pass integer,
  payload      jsonb not null default '{}',
  created_at   timestamptz not null default now()
);

-- Append-only: block updates and deletes at the rule level
create rule game_events_no_update
  as on update to nota_games.game_events do instead nothing;

create rule game_events_no_delete
  as on delete to nota_games.game_events do instead nothing;

-- ─── Indexes ──────────────────────────────────────────────────────────────────

-- Primary query pattern: all events for a session (audit, replay)
create index idx_game_events_session
  on nota_games.game_events(session_id, created_at desc);

-- Filter by event type within a session (e.g. all xp_awarded events)
create index idx_game_events_session_type
  on nota_games.game_events(session_id, event_type);

-- Filter by pass within a session (per-pass replay and scoring audit)
create index idx_game_events_session_pass
  on nota_games.game_events(session_id, current_pass)
  where current_pass is not null;

-- ─── Row Level Security ───────────────────────────────────────────────────────

alter table nota_games.game_events enable row level security;

-- service_role has full access (bypasses RLS)
grant all on nota_games.game_events to service_role;

-- authenticated users can read events from sessions they are in
grant select on nota_games.game_events to authenticated;

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

-- No insert policy for authenticated users — only service_role writes events.
-- This means the game engine must use the service role key for event logging,
-- which it already does via the supabase client in src/lib/supabase.ts.
