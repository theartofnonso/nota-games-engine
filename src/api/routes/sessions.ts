import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { supabase } from '../../lib/supabase.js';
import { getChannelName } from '../../realtime/channels.js';
import { subscribeToSession } from '../../realtime/motion-subscriber.js';
import logger from '../../lib/logger.js';
import {
  getOrCreateSession,
  registerPlayer,
  removePlayer,
} from '../../sessions/session-registry.js';
import { PlayerMotionBatchSchema } from '../../types/motion.js';
import { validate, validateUUIDParam } from '../middleware/validate.js';
import type { PlayerMotionBatch } from '../../types/motion.js';

export const sessionsRouter = Router();

// Reject non-UUID session IDs at the router boundary before any handler runs
sessionsRouter.param('id', validateUUIDParam);

// ─── POST /sessions/:id/join ──────────────────────────────────────────────────
// Self-registration + join in one step. No auth required.
//
// First-time join: player sends { playerName } and optionally a client-generated
// { playerId } UUID. Server registers them as a participant and returns the
// playerId. The mobile app should persist this UUID and send it on every
// subsequent call (motion batches, re-joins, leave).
//
// Re-join (disconnect/reconnect): player sends the same { playerId } they
// received on first join. Server finds the existing participant record and
// re-activates the session subscription and presence tracking.
//
// Team assignment is NOT done here — the instructor triggers it separately
// from the dashboard after all players have joined.

const JoinSessionSchema = z.object({
  playerName: z.string().min(1),
  playerId:   z.string().uuid().optional(),
});

sessionsRouter.post(
  '/:id/join',
  validate(JoinSessionSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sessionId  = req.params.id as string;
    const { playerName, playerId: clientPlayerId } = req.body as z.infer<typeof JoinSessionSchema>;

    // Confirm the session exists and is joinable
    const { data: session, error: sessionError } = await supabase
      .schema('nota_games')
      .from('sessions')
      .select('status')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (session.status === 'ended') {
      res.status(403).json({ error: 'Session has already ended' });
      return;
    }

    const playerId = clientPlayerId ?? randomUUID();

    // Check for an existing participant record — handles re-joins
    const { data: existing } = await supabase
      .schema('nota_games')
      .from('session_participants')
      .select('player_name, team_id, duo_id')
      .eq('session_id', sessionId)
      .eq('player_id', playerId)
      .single();

    let participant = existing;
    let isRejoin    = !!existing;

    if (!participant) {
      // First-time join — self-register
      const { data: inserted, error: insertError } = await supabase
        .schema('nota_games')
        .from('session_participants')
        .insert({
          session_id:  sessionId,
          player_id:   playerId,
          player_name: playerName,
          assigned_by: 'auto',
        })
        .select('player_name, team_id, duo_id')
        .single();

      if (insertError || !inserted) {
        logger.error({ sessionId, playerId, err: insertError?.message }, 'failed to register participant');
        res.status(500).json({ error: 'Failed to register player', detail: insertError?.message });
        return;
      }

      logger.info({ sessionId, playerId, playerName }, 'participant self-registered');
      participant = inserted;
    }

    // Cache player metadata in session registry (idempotent — safe on re-join)
    registerPlayer(
      sessionId,
      playerId,
      participant.player_name,
      participant.team_id ?? undefined,
      participant.duo_id  ?? undefined,
    );

    // Ensure realtime subscription is active for this session (idempotent)
    const sessionRecord = getOrCreateSession(sessionId);
    subscribeToSession(sessionId);

    logger.info(
      { sessionId, playerId, playerName: participant.player_name, isRejoin },
      isRejoin ? 'player rejoined session' : 'player joined session',
    );

    if (!isRejoin) {
      await supabase
        .schema('nota_games')
        .from('game_events')
        .insert({
          session_id: sessionId,
          player_id:  playerId,
          event_type: 'player_joined',
          payload:    { playerName: participant.player_name },
        });
    }

    res.status(200).json({
      sessionId,
      playerId,
      playerName: participant.player_name,
      teamId:     participant.team_id ?? null,
      duoId:      participant.duo_id  ?? null,
      isRejoin,
      // Current game state — non-null only when the session is already running.
      // Late joiners and re-joiners should check this and start motion immediately
      // if isRunning is true, rather than waiting for the next state broadcast.
      gameState: sessionRecord.gameState ?? null,
    });
  },
);

// ─── POST /sessions/:id/motion ────────────────────────────────────────────────
// Receives a PlayerMotionBatch from the mobile app and publishes it
// to the session:motion realtime channel.

sessionsRouter.post(
  '/:id/motion',
  validate(PlayerMotionBatchSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.params.id as string;
    const batch     = req.body as PlayerMotionBatch;

    // Confirm player has joined this session
    const session = getOrCreateSession(sessionId);
    if (!session.players.has(batch.playerId)) {
      res.status(403).json({ error: 'Not joined to this session. Call /join first.' });
      return;
    }

    // Reuse the channel already held in the registry — avoids creating and
    // abandoning a new Supabase channel object on every motion batch request.
    const motionChannel = session.motionChannel ?? supabase.channel(getChannelName('motion', sessionId));
    const sendError = await motionChannel.send({
      type:    'broadcast',
      event:   'motion_batch',
      payload: batch,
    });

    if (sendError !== 'ok') {
      logger.error({ sessionId, playerId: batch.playerId, sendError }, 'failed to publish motion batch');
      res.status(502).json({ error: 'Failed to publish motion batch to realtime' });
      return;
    }

    logger.debug({ sessionId, playerId: batch.playerId, sampleCount: batch.samples.length, batchStartedAt: batch.batchStartedAt }, 'motion batch published');
    res.status(202).json({ received: true, batchStartedAt: batch.batchStartedAt });
  },
);

// ─── DELETE /sessions/:id/leave ──────────────────────────────────────────────
// Called when the player exits the session (app background, disconnect, etc.).

const LeaveSessionSchema = z.object({
  playerId: z.string().uuid(),
});

sessionsRouter.delete(
  '/:id/leave',
  validate(LeaveSessionSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.params.id as string;
    const { playerId } = req.body as z.infer<typeof LeaveSessionSchema>;

    removePlayer(sessionId, playerId);
    logger.info({ sessionId, playerId }, 'player left session');

    await supabase
      .schema('nota_games')
      .from('game_events')
      .insert({
        session_id: sessionId,
        player_id:  playerId,
        event_type: 'player_left',
        payload:    {},
      });

    res.status(200).json({ left: true });
  },
);
