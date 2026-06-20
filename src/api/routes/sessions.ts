import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../../lib/supabase.js';
import { getChannelName } from '../../realtime/channels.js';
import { subscribeToSession } from '../../realtime/motion-subscriber.js';
import logger from '../../lib/logger.js';
import { trackPlayerPresence, untrackPlayerPresence } from '../../realtime/presence.js';
import {
  getOrCreateSession,
  registerPlayer,
} from '../../sessions/session-registry.js';
import { PlayerMotionBatchSchema } from '../../types/motion.js';
import { validate } from '../middleware/validate.js';
import type { PlayerMotionBatch } from '../../types/motion.js';

export const sessionsRouter = Router();

// ─── POST /sessions/:id/join ──────────────────────────────────────────────────
// Called once by the mobile app when a player enters a session.
// No auth required — player identifies themselves by their pre-registered playerId.

const JoinSessionSchema = z.object({
  playerId: z.string().uuid(),
});

sessionsRouter.post(
  '/:id/join',
  validate(JoinSessionSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.params.id as string;
    const { playerId } = req.body as z.infer<typeof JoinSessionSchema>;

    // Confirm the session exists and is in a joinable state.
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

    // Confirm player is pre-registered as a participant in this session.
    const { data: participant, error: participantError } = await supabase
      .schema('nota_games')
      .from('session_participants')
      .select('player_name, team_id, duo_id')
      .eq('session_id', sessionId)
      .eq('player_id', playerId)
      .single();

    if (participantError || !participant) {
      res.status(403).json({ error: 'Not registered for this session' });
      return;
    }

    // Cache player metadata in session registry
    registerPlayer(
      sessionId,
      playerId,
      participant.player_name,
      participant.team_id ?? undefined,
      participant.duo_id  ?? undefined,
    );

    // Ensure realtime subscription is active for this session (idempotent)
    getOrCreateSession(sessionId);
    subscribeToSession(sessionId);

    // Track presence — dashboard sees connected players in real time
    trackPlayerPresence(
      sessionId,
      playerId,
      participant.player_name,
      participant.team_id ?? null,
      participant.duo_id  ?? null,
    );

    logger.info(
      { sessionId, playerId, playerName: participant.player_name, teamId: participant.team_id ?? null, duoId: participant.duo_id ?? null },
      'player joined session',
    );

    // Log player_joined event
    await supabase
      .schema('nota_games')
      .from('game_events')
      .insert({
        session_id: sessionId,
        player_id:  playerId,
        event_type: 'player_joined',
        payload: {
          playerName: participant.player_name,
          teamId:     participant.team_id,
          duoId:      participant.duo_id,
        },
      });

    res.status(200).json({
      sessionId,
      playerId,
      playerName: participant.player_name,
      teamId:     participant.team_id ?? null,
      duoId:      participant.duo_id  ?? null,
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

    const channel  = supabase.channel(getChannelName('motion', sessionId));
    const sendError = await channel.send({
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

    await untrackPlayerPresence(sessionId, playerId);

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
