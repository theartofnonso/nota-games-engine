-- =============================================================================
-- nota-game-engine  |  stored functions
-- =============================================================================

-- =============================================================================
-- upsert_score
-- =============================================================================
-- Called by the game engine after every scored motion batch.
-- Accumulates XP per-player, per-pass, then recomputes:
--   • individual overall_rank
--   • individual current_pass_rank
--   • duo_total_xp + duo_rank  (when p_duo_id is not null)
-- All rank updates are scoped to p_session_id so concurrent sessions
-- never interfere with each other.

create or replace function nota_games.upsert_score(
  p_session_id   uuid,
  p_player_id    uuid,
  p_player_name  text,
  p_team_id      uuid,
  p_duo_id       uuid,
  p_xp_delta     numeric,
  p_current_pass integer
)
returns void
language plpgsql
security definer
set search_path = nota_games, public
as $$
begin
  -- Upsert the player's result row
  insert into nota_games.session_results
    (session_id, player_id, player_name, team_id, duo_id, total_xp, pass_xp, updated_at)
  values (
    p_session_id,
    p_player_id,
    p_player_name,
    p_team_id,
    p_duo_id,
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

  -- Recompute duo_total_xp for all players in the same duo (if duo exists)
  if p_duo_id is not null then
    update nota_games.session_results r
    set duo_total_xp = agg.combined
    from (
      select player_id, sum(total_xp) over (partition by duo_id) as combined
      from nota_games.session_results
      where session_id = p_session_id
        and duo_id     = p_duo_id
    ) agg
    where r.session_id = p_session_id
      and r.player_id  = agg.player_id;

    -- Recompute duo ranks across all duos in the session
    update nota_games.session_results r
    set duo_rank = ranked.new_rank
    from (
      select distinct on (duo_id)
             duo_id,
             duo_total_xp,
             rank() over (
               partition by session_id
               order by duo_total_xp desc nulls last
             ) as new_rank
      from nota_games.session_results
      where session_id = p_session_id
        and duo_id is not null
    ) ranked
    where r.session_id = p_session_id
      and r.duo_id     = ranked.duo_id;
  end if;

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

-- =============================================================================
-- get_leaderboard
-- =============================================================================
-- Returns the ranked leaderboard for a session.
-- Pass p_pass = null  → sort by overall_rank (total XP across all passes).
-- Pass p_pass = N     → sort by current_pass_rank (XP for pass N only).
-- Joins teams and duos to surface display names.

create or replace function nota_games.get_leaderboard(
  p_session_id uuid,
  p_pass       integer default null
)
returns table (
  player_id         uuid,
  player_name       text,
  team_id           uuid,
  team_name         text,
  duo_id            uuid,
  duo_name          text,
  total_xp          numeric,
  overall_rank      integer,
  duo_total_xp      numeric,
  duo_rank          integer,
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
    r.duo_id,
    d.name                                                      as duo_name,
    r.total_xp,
    r.overall_rank,
    r.duo_total_xp,
    r.duo_rank,
    coalesce((r.pass_xp ->> p_pass::text)::numeric, 0)         as pass_xp,
    r.current_pass_rank
  from nota_games.session_results r
  left join nota_games.teams t on t.id = r.team_id
  left join nota_games.duos  d on d.id = r.duo_id
  where r.session_id = p_session_id
  order by
    case when p_pass is null then r.overall_rank
         else r.current_pass_rank
    end asc nulls last;
$$;

-- =============================================================================
-- Function grants
-- (security definer functions bypass RLS internally;
--  grant execute only to the roles that should call them)
-- =============================================================================

grant execute on function nota_games.upsert_score    to service_role;
grant execute on function nota_games.get_leaderboard to authenticated, service_role;
