import { supabase } from '../lib/supabase.js';
import { getChannelName } from './channels.js';
import logger from '../lib/logger.js';
import { subscribeToPresence } from './presence.js';
import {
  getOrCreateSession,
  registerPlayer,
  updateGameState,
  setChannel,
} from '../sessions/session-registry.js';
import type { PlayerMotionBatch } from '../types/motion.js';
import type { RuntimeGameState, ScoresBroadcastPayload, TeamScore } from '../types/session.js';

// Scores a motion batch and broadcasts the updated leaderboard.
// Called directly by the POST /sessions/:id/motion HTTP handler — there is no
// Realtime relay because the server is both publisher and subscriber on the
// motion channel, and Supabase disables self-echo by default.
export async function scoreAndBroadcast(
  sessionId: string,
  batch: PlayerMotionBatch,
): Promise<void> {
  const session = getOrCreateSession(sessionId);

  if (!session.gameState) {
    logger.warn({ sessionId, playerId: batch.playerId }, 'motion batch received before game state — skipping score');
    registerPlayer(sessionId, batch.playerId, batch.playerName);
    return;
  }

  const { state } = session.gameState;

  // Register player metadata on first sight (idempotent)
  registerPlayer(sessionId, batch.playerId, batch.playerName);

  // Run the full scoring pipeline. Skip entirely when paused so window
  // history is frozen — scores resume from the same level on unpause.
  const xpDelta = state.isPaused
    ? 0
    : session.engine.processMotionBatch(batch.playerId, batch, state.phase);
  const totalXp = session.engine.getPlayerXp(batch.playerId);
  logger.debug({ sessionId, playerId: batch.playerId, xpDelta, totalXp, phase: state.phase }, 'motion batch scored');

  // Persist to Postgres via upsert_score function
  const { error: dbError } = await supabase.schema('nota_games').rpc('upsert_score', {
    p_session_id:   sessionId,
    p_player_id:    batch.playerId,
    p_player_name:  batch.playerName,
    p_team_id:      session.players.get(batch.playerId)?.teamId ?? null,
    p_xp_delta:     xpDelta,
    p_current_pass: state.currentPass,
  });

  if (dbError) {
    logger.error({ sessionId, playerId: batch.playerId, err: dbError.message }, 'upsert_score failed');
    return;
  }

  // Log motion_batch_received event (fire and forget)
  supabase
    .schema('nota_games')
    .from('game_events')
    .insert({
      session_id:   sessionId,
      player_id:    batch.playerId,
      event_type:   'motion_batch_received',
      phase:        state.phase,
      current_pass: state.currentPass,
      payload: {
        sampleCount:    batch.samples.length,
        sampleRateHz:   batch.sampleRateHz,
        xpDelta,
        totalXp,
        batchStartedAt: batch.batchStartedAt,
        batchEndedAt:   batch.batchEndedAt,
      },
    })
    .then(({ error }) => {
      if (error) logger.error({ sessionId, playerId: batch.playerId, err: error.message }, 'motion event log failed');
    });

  // Broadcast updated leaderboard to session:{id}:scores
  // Enrich engine entries with player metadata from the registry
  const rawLeaderboard = session.engine.getLeaderboard().map((entry) => {
    const meta = session.players.get(entry.playerId);
    return {
      ...entry,
      playerName: meta?.playerName ?? 'Unknown',
      teamId:     meta?.teamId ?? null,
    };
  });

  // Sum raw XP per team
  const teamTotals = new Map<string, number>();
  for (const entry of rawLeaderboard) {
    if (entry.teamId) {
      teamTotals.set(entry.teamId, (teamTotals.get(entry.teamId) ?? 0) + entry.total_xp);
    }
  }

  // Normalize: leading team is scaled to exactly 1000; all others scale proportionally.
  // If no team exceeds 1000 the scale factor stays 1 (scores are shown as-is).
  const maxTeamXp = teamTotals.size > 0 ? Math.max(...teamTotals.values()) : 0;
  const scale = maxTeamXp > 1000 ? 1000 / maxTeamXp : 1;

  const leaderboard = rawLeaderboard.map((entry) => ({
    ...entry,
    total_xp: Math.round(entry.total_xp * scale),
  }));

  const teams: TeamScore[] = Array.from(teamTotals.entries())
    .map(([teamId, totalXp]) => ({ teamId, totalXp: Math.round(totalXp * scale) }))
    .sort((a, b) => b.totalXp - a.totalXp);

  const scoresPayload: ScoresBroadcastPayload = {
    sessionId,
    updatedAt: Date.now(),
    teams,
    leaderboard,
  };

  let scoresChannel = session.scoresChannel;
  if (!scoresChannel) {
    scoresChannel = supabase.channel(getChannelName('scores', sessionId));
    setChannel(sessionId, 'scores', scoresChannel);
  }
  await scoresChannel.httpSend('leaderboard_update', scoresPayload);
}

// Subscribes the server to the session's state and presence channels.
// Called once per session on the first player join (idempotent via stateChannel guard).
//
// Motion batches are NOT relayed through Realtime — they are scored directly
// in the HTTP handler via scoreAndBroadcast() to avoid the self-echo limitation.
export function subscribeToSession(sessionId: string): void {
  const session = getOrCreateSession(sessionId);
  if (session.stateChannel) return; // already subscribed — safe to call on every player join

  // ── State channel: receives RuntimeGameState from the game controller ──
  // Stored in registry so dashboard.ts can reuse the channel object for httpSend.
  const stateChannel = supabase.channel(getChannelName('state', sessionId));

  stateChannel
    .on('broadcast', { event: 'session_state_change' }, ({ payload }) => {
      const gameState = payload as RuntimeGameState;
      updateGameState(sessionId, gameState);
    })
    .subscribe();

  setChannel(sessionId, 'state', stateChannel);

  // Presence listener — re-broadcasts to scores channel on every client
  // join/leave so the controller sees connection changes in real time.
  subscribeToPresence(sessionId);
}
