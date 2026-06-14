-- =============================================================================
-- nota-game-engine  |  base schema
-- =============================================================================

create schema if not exists nota_games;

-- =============================================================================
-- Enums
-- =============================================================================

create type nota_games.team_format as enum (
  'solo',   -- no teams, every player ranked individually
  'team',   -- players grouped into named teams; duos optional within teams
  'mixed'   -- teams contain a mix of solo players and duos
);

-- =============================================================================
-- Sessions
-- =============================================================================

create table nota_games.sessions (
  id            uuid        primary key default gen_random_uuid(),
  name          text        not null,
  team_format   nota_games.team_format not null default 'solo',
  status        text        not null default 'pending'
                              check (status in ('pending', 'active', 'paused', 'ended')),
  current_pass  integer     not null default 1,
  created_by    uuid,                         -- auth.users(id); nullable for server-created sessions
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  ended_at      timestamptz
);

create index idx_sessions_status on nota_games.sessions(status);

-- =============================================================================
-- Teams
-- =============================================================================

create table nota_games.teams (
  id          uuid        primary key default gen_random_uuid(),
  session_id  uuid        not null references nota_games.sessions(id) on delete cascade,
  name        text        not null,
  created_at  timestamptz not null default now()
);

create index idx_teams_session on nota_games.teams(session_id);

-- =============================================================================
-- Duos
-- =============================================================================
-- Optional sub-grouping within a team. Two players paired together.
-- Created either automatically (server assigns) or manually (instructor assigns).
-- A player can only be in one duo per session.

create table nota_games.duos (
  id           uuid        primary key default gen_random_uuid(),
  session_id   uuid        not null references nota_games.sessions(id) on delete cascade,
  team_id      uuid        not null references nota_games.teams(id)    on delete cascade,
  name         text,                 -- optional display name e.g. "Duo A", auto-generated if null
  assigned_by  text        not null default 'auto' check (assigned_by in ('auto', 'manual')),
  created_at   timestamptz not null default now(),

  constraint duos_belong_to_team_session
    check (true)            -- enforced via FK; team_id already ties to session implicitly
);

create index idx_duos_session on nota_games.duos(session_id);
create index idx_duos_team    on nota_games.duos(team_id);

-- =============================================================================
-- Session Participants
-- =============================================================================

create table nota_games.session_participants (
  id           uuid        primary key default gen_random_uuid(),
  session_id   uuid        not null references nota_games.sessions(id) on delete cascade,
  player_id    uuid        not null,
  player_name  text        not null,
  team_id      uuid        references nota_games.teams(id),
  duo_id       uuid        references nota_games.duos(id),
  assigned_by  text        not null default 'auto' check (assigned_by in ('auto', 'manual')),
  joined_at    timestamptz not null default now(),

  constraint participant_duo_in_same_team
    check (duo_id is null or team_id is not null),  -- can't be in a duo without a team

  unique (session_id, player_id)
);

create index idx_participants_session on nota_games.session_participants(session_id);
create index idx_participants_player  on nota_games.session_participants(player_id);
create index idx_participants_duo     on nota_games.session_participants(duo_id);

-- =============================================================================
-- Session Results  (live leaderboard, one row per player per session)
-- =============================================================================

create table nota_games.session_results (
  id                uuid        primary key default gen_random_uuid(),
  session_id        uuid        not null references nota_games.sessions(id) on delete cascade,
  player_id         uuid        not null,
  player_name       text        not null,
  team_id           uuid        references nota_games.teams(id),
  duo_id            uuid        references nota_games.duos(id),

  total_xp          numeric(12, 4) not null default 0,
  overall_rank      integer,

  duo_total_xp      numeric(12, 4),   -- combined XP with duo partner (null if solo/no duo)
  duo_rank          integer,          -- rank among all duos in the session

  pass_xp           jsonb          not null default '{}',
  current_pass_rank integer,

  updated_at        timestamptz not null default now(),

  unique (session_id, player_id)
);

create index idx_results_session  on nota_games.session_results(session_id);
create index idx_results_player   on nota_games.session_results(player_id);
create index idx_results_total_xp on nota_games.session_results(session_id, total_xp desc);
create index idx_results_duo_xp   on nota_games.session_results(session_id, duo_total_xp desc nulls last);
