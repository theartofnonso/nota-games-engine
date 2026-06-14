-- =============================================================================
-- nota-game-engine  |  enums required by game_events table
-- Must be applied before 20240004_nota_games_events_table.sql
-- =============================================================================

-- Phase of a session interval — mirrors SessionPhase in src/types/session.ts
create type nota_games.session_phase as enum (
  'work',        -- active scoring window
  'rest',        -- rest interval between stations
  'passBreak',   -- break between passes
  'complete'     -- session fully finished
);

-- All event types that can be written to nota_games.game_events
create type nota_games.event_type as enum (
  'motion_batch_received',   -- mobile device sent a scored batch
  'xp_awarded',              -- XP delta applied to a player
  'player_joined',           -- participant row created
  'player_left',             -- participant disconnected
  'session_started',         -- session status → active
  'session_paused',          -- session status → paused
  'session_resumed',         -- session status → active (from paused)
  'session_ended',           -- session status → ended
  'pass_started',            -- new pass began
  'pass_ended'               -- pass completed
);
