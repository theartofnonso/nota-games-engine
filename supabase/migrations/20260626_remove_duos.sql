-- =============================================================================
-- nota-game-engine  |  remove duos
-- =============================================================================
-- Each player is now an individual participant. Duo grouping is removed from
-- all tables and functions. Teams (Red / Blue) remain unchanged.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. session_participants — drop duo constraint and column
-- ---------------------------------------------------------------------------

alter table nota_games.session_participants
  drop constraint participant_duo_in_same_team;

alter table nota_games.session_participants
  drop column duo_id;
-- idx_participants_duo is automatically dropped with the column

-- ---------------------------------------------------------------------------
-- 2. session_results — drop duo columns
-- ---------------------------------------------------------------------------

alter table nota_games.session_results
  drop column duo_id,
  drop column duo_total_xp,
  drop column duo_rank;
-- idx_results_duo_xp is automatically dropped with the column

-- ---------------------------------------------------------------------------
-- 3. duos table — drop (RLS policies and indexes auto-drop with it)
-- ---------------------------------------------------------------------------

drop table nota_games.duos;

-- ---------------------------------------------------------------------------
-- 4. upsert_score — replace without p_duo_id
-- ---------------------------------------------------------------------------

-- Drop by full signature since argument list is changing
drop function nota_games.upsert_score(uuid, uuid, text, uuid, uuid, numeric, integer);

create function nota_games.upsert_score(
  p_session_id   uuid,
  p_player_id    uuid,
  p_player_name  text,
  p_team_id      uuid,
  p_xp_delta     numeric,
  p_current_pass integer
)
returns void
language plpgsql
security definer
set search_path = nota_games, public
as $$
begin
  insert into nota_games.session_results
    (session_id, player_id, player_name, team_id, total_xp, pass_xp, updated_at)
  values (
    p_session_id,
    p_player_id,
    p_player_name,
    p_team_id,
    greatest(0, p_xp_delta),
    jsonb_build_object(p_current_pass::text, greatest(0, p_xp_delta)),
    now()
  )
  on conflict (session_id, player_id) do update set
    total_xp   = greatest(0, session_results.total_xp + p_xp_delta),
    pass_xp    = jsonb_set(
                   session_results.pass_xp,
                   array[p_current_pass::text],
                   to_jsonb(
                     greatest(
                       0,
                       coalesce(
                         (session_results.pass_xp ->> p_current_pass::text)::numeric,
                         0
                       ) + p_xp_delta
                     )
                   )
                 ),
    updated_at = now();

  -- Recompute overall individual ranks
  update nota_games.session_results r
  set overall_rank = ranked.new_rank
  from (
    select player_id,
           rank() over (order by total_xp desc) as new_rank
    from nota_games.session_results
    where session_id = p_session_id
  ) ranked
  where r.session_id = p_session_id
    and r.player_id  = ranked.player_id;

  -- Recompute current-pass individual ranks
  update nota_games.session_results r
  set current_pass_rank = ranked.new_rank
  from (
    select player_id,
           rank() over (
             order by
               coalesce((pass_xp ->> p_current_pass::text)::numeric, 0) desc
           ) as new_rank
    from nota_games.session_results
    where session_id = p_session_id
  ) ranked
  where r.session_id = p_session_id
    and r.player_id  = ranked.player_id;
end;
$$;

grant execute on function nota_games.upsert_score to service_role;

-- ---------------------------------------------------------------------------
-- 5. get_leaderboard — replace without duo columns
-- ---------------------------------------------------------------------------

-- Drop by signature since return type is changing
drop function nota_games.get_leaderboard(uuid, integer);

create function nota_games.get_leaderboard(
  p_session_id uuid,
  p_pass       integer default null
)
returns table (
  player_id         uuid,
  player_name       text,
  team_id           uuid,
  team_name         text,
  total_xp          numeric,
  overall_rank      integer,
  pass_xp           numeric,
  current_pass_rank integer
)
language sql
security definer
set search_path = nota_games, public
as $$
  select
    r.player_id,
    r.player_name,
    r.team_id,
    t.name                                                      as team_name,
    r.total_xp,
    r.overall_rank,
    coalesce((r.pass_xp ->> p_pass::text)::numeric, 0)         as pass_xp,
    r.current_pass_rank
  from nota_games.session_results r
  left join nota_games.teams t on t.id = r.team_id
  where r.session_id = p_session_id
  order by
    case when p_pass is null then r.overall_rank
         else r.current_pass_rank
    end asc nulls last;
$$;

grant execute on function nota_games.get_leaderboard to authenticated, service_role;
