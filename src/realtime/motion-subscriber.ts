import { supabase } from '../lib/supabase.js';
import { getChannelName } from './channels.js';
import { scoreBatch } from '../game/scoring.js';
import {
  getOrCreateSession,
  registerPlayer,
  updateGameState,
  setChannel,
} from '../sessions/session-registry.js';
import type { PlayerMotionBatch } from '../types/motion.js';
import type { RuntimeGameState, ScoresBroadcastPayload } from '../types/session.js';
import type { PresenceBroadcastPayload } from '../types/presence.js';

export function subscribeToSession(sessionId: string): void {
  // ── Motion channel: receives PlayerMotionBatch from mobile devices ──
  const motionChannel = supabase.channel(getChannelName('motion', sessionId));

  motionChannel
    .on('broadcast', { event: 'motion_batch' }, async ({ payload }) => {
      const batch = payload as PlayerMotionBatch;

      // Look up current game state — needed for phase-aware scoring
      const session = getOrCreateSession(sessionId);

      if (!session.gameState) {
        // Game state not yet received; skip scoring but register player
        registerPlayer(sessionId, batch.playerId, batch.playerName);
        return;
      }

      const { state } = session.gameState;

      // Register player metadata on first sight (idempotent)
      registerPlayer(sessionId, batch.playerId, batch.playerName);

      // Score the batch — returns 0 during rest/passBreak/complete
      const xpDelta = scoreBatch(batch, state.phase);

      // Update in-memory engine
      session.engine.updatePlayer(batch.playerId, xpDelta);
      const totalXp = session.engine.getPlayerXp(batch.playerId);

      // Persist to Postgres via upsert_score function
      const { error: dbError } = await supabase.schema('nota_games').rpc('upsert_score', {
        p_session_id:   sessionId,
        p_player_id:    batch.playerId,
        p_player_name:  batch.playerName,
        p_team_id:      session.players.get(batch.playerId)?.teamId ?? null,
        p_duo_id:       session.players.get(batch.playerId)?.duoId  ?? null,
        p_xp_delta:     xpDelta,
        p_current_pass: state.currentPass,
      });

      if (dbError) {
        console.error('[motion] upsert_score failed:', dbError.message);
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
          if (error) console.error('[motion] event log failed:', error.message);
        });

      // Broadcast updated leaderboard to session:{id}:scores
      const leaderboard = session.engine.getLeaderboard().map((entry) => {
        const meta = session.players.get(entry.playerId);
        return {
          ...entry,
          playerName: meta?.playerName ?? 'Unknown',
        };
      });

      const scoresPayload: ScoresBroadcastPayload = {
        sessionId,
        updatedAt: Date.now(),
        leaderboard,
      };

      // Use persistent scores channel — create once, reuse on every batch
      let scoresChannel = session.scoresChannel;
      if (!scoresChannel) {
        scoresChannel = supabase.channel(getChannelName('scores', sessionId));
        scoresChannel.subscribe();
        setChannel(sessionId, 'scores', scoresChannel);
      }
      await scoresChannel.send({
        type: 'broadcast',
        event: 'leaderboard_update',
        payload: scoresPayload,
      });
    })
    .subscribe();
  setChannel(sessionId, 'motion', motionChannel);

  // ── State channel: receives RuntimeGameState from the game controller ──
  // Also used by dashboard PATCH /sessions/:id/state to broadcast state
  // updates; store in registry so the same channel object is reused.
  const stateChannel = supabase.channel(getChannelName('state', sessionId));

  stateChannel
    .on('broadcast', { event: 'session_state_change' }, ({ payload }) => {
      const gameState = payload as RuntimeGameState;
      updateGameState(sessionId, gameState);
    })
    .subscribe();

  setChannel(sessionId, 'state', stateChannel);
}
