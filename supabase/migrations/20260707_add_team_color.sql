-- =============================================================================
-- nota-game-engine  |  add color to teams
-- =============================================================================

alter table nota_games.teams
  add column color text not null default '#6B7280';

-- Set canonical colors for any existing Red / Blue teams
update nota_games.teams set color = '#EF4444' where lower(name) = 'red';
update nota_games.teams set color = '#3B82F6' where lower(name) = 'blue';
