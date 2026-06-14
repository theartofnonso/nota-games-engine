-- =============================================================================
-- nota-game-engine  |  Row Level Security
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

grant select on nota_games.sessions to authenticated;

-- Authenticated users can read any session (join-by-id model)
create policy "authenticated users can read sessions"
  on nota_games.sessions for select
  to authenticated
  using (true);

-- Only the creator or service_role can mutate sessions
create policy "creator can update their session"
  on nota_games.sessions for update
  to authenticated
  using (created_by = auth.uid());

alter table nota_games.sessions enable row level security;
grant all on nota_games.sessions to service_role;

-- ---------------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------------

grant select on nota_games.teams to authenticated;

-- Players can read teams in sessions they are part of
create policy "participants can read teams in their session"
  on nota_games.teams for select
  to authenticated
  using (
    exists (
      select 1 from nota_games.session_participants sp
      where sp.session_id = teams.session_id
        and sp.player_id  = auth.uid()
    )
  );

alter table nota_games.teams enable row level security;
grant all on nota_games.teams to service_role;

-- ---------------------------------------------------------------------------
-- Duos
-- ---------------------------------------------------------------------------

grant select on nota_games.duos to authenticated;

-- Players can read duos in sessions they are part of
create policy "participants can read duos in their session"
  on nota_games.duos for select
  to authenticated
  using (
    exists (
      select 1 from nota_games.session_participants sp
      where sp.session_id = duos.session_id
        and sp.player_id  = auth.uid()
    )
  );

alter table nota_games.duos enable row level security;
grant all on nota_games.duos to service_role;

-- ---------------------------------------------------------------------------
-- Session Participants
-- ---------------------------------------------------------------------------

grant select on nota_games.session_participants to authenticated;

-- Players can read the participant list for sessions they have joined
create policy "participants can read their session roster"
  on nota_games.session_participants for select
  to authenticated
  using (
    exists (
      select 1 from nota_games.session_participants sp
      where sp.session_id = session_participants.session_id
        and sp.player_id  = auth.uid()
    )
  );

-- Players can insert their own participant row
create policy "players can join a session"
  on nota_games.session_participants for insert
  to authenticated
  with check (player_id = auth.uid());

alter table nota_games.session_participants enable row level security;
grant all on nota_games.session_participants to service_role;

-- ---------------------------------------------------------------------------
-- Session Results
-- ---------------------------------------------------------------------------

grant select on nota_games.session_results to authenticated;

-- Players can read the leaderboard for sessions they are part of
create policy "participants can read results in their session"
  on nota_games.session_results for select
  to authenticated
  using (
    exists (
      select 1 from nota_games.session_participants sp
      where sp.session_id = session_results.session_id
        and sp.player_id  = auth.uid()
    )
  );

alter table nota_games.session_results enable row level security;
grant all on nota_games.session_results to service_role;

-- Note: function grants live in 20240003_nota_games_functions.sql,
-- after the functions themselves are created.
