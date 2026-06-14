import { Router } from 'express';
import type { Request, Response } from 'express';
import { supabase, supabaseForUser } from '../../lib/supabase.js';
import { getChannelName } from '../../realtime/channels.js';
import { subscribeToSession } from '../../realtime/motion-subscriber.js';
import { trackPlayerPresence, untrackPlayerPresence } from '../../realtime/presence.js';
import {
  getOrCreateSession,
  registerPlayer,
} from '../../sessions/session-registry.js';
import { PlayerMotionBatchSchema } from '../../types/motion.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import type { PlayerMotionBatch } from '../../types/motion.js';

export const sessionsRouter = Router();

// All player-facing session routes require authentication
sessionsRouter.use(requireAuth);

// ─── POST /sessions/:id/join ──────────────────────────────────────────────────
// Called once by the mobile app when a player enters a session.
// Looks up their participant record (pre-assigned by instructor),
// caches their team/duo context in the session registry,
// and ensures the realtime subscription for this session is active.

sessionsRouter.post('/:id/join', async (req: Request, res: Response): Promise<void> => {
  const sessionId = req.params.id as string;
  const user      = req.user;

  // Confirm player is a registered participant in this session.
  // Use the user-scoped client so RLS applies — players can only read
  // participants in sessions they belong to (policy: "participants can
  // read their session roster").
  const { data: participant, error: participantError } = await supabaseForUser(req.jwt)
    .schema('nota_games')
    .from('session_participants')
    .select('player_name, team_id, duo_id')
    .eq('session_id', sessionId)
    .eq('player_id', user.id)
    .single();

  if (participantError || !participant) {
    res.status(403).json({ error: 'Not registered for this session' });
    return;
  }

  // Cache player metadata in session registry —
  // this is what resolves team_id and duo_id in motion-subscriber.ts
  registerPlayer(
    sessionId,
    user.id,
    participant.player_name,
    participant.team_id ?? undefined,
    participant.duo_id  ?? undefined,
  );

  // Ensure realtime subscription is active for this session.
  // getOrCreateSession and subscribeToSession are both idempotent.
  getOrCreateSession(sessionId);
  subscribeToSession(sessionId);

  // Track presence — dashboard sees connected players in real time
  trackPlayerPresence(
    sessionId,
    user.id,
    participant.player_name,
    participant.team_id ?? null,
    participant.duo_id  ?? null,
  );

  // Log player_joined event
  await supabase
    .schema('nota_games')
    .from('game_events')
    .insert({
      session_id: sessionId,
      player_id:  user.id,
      event_type: 'player_joined',
      payload: {
        playerName: participant.player_name,
        teamId:     participant.team_id,
        duoId:      participant.duo_id,
      },
    });

  res.status(200).json({
    sessionId,
    playerId:   user.id,
    playerName: participant.player_name,
    teamId:     participant.team_id  ?? null,
    duoId:      participant.duo_id   ?? null,
  });
});

// ─── POST /sessions/:id/motion ────────────────────────────────────────────────
// Receives a PlayerMotionBatch from the mobile app and publishes it
// to the session:motion realtime channel.
// The Game Engine (motion-subscriber.ts) handles scoring from there.

sessionsRouter.post(
  '/:id/motion',
  validate(PlayerMotionBatchSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.params.id as string;
    const batch     = req.body as PlayerMotionBatch;
    const user      = req.user;

    // Confirm player has joined this session
    const session = getOrCreateSession(sessionId);
    if (!session.players.has(user.id)) {
      res.status(403).json({ error: 'Not joined to this session. Call /join first.' });
      return;
    }

    // Publish batch to the realtime motion channel.
    // The Game Engine subscriber picks this up, scores it,
    // persists to DB, and broadcasts the leaderboard update.
    const channel = supabase.channel(getChannelName('motion', sessionId));
    const sendError = await channel.send({
      type:    'broadcast',
      event:   'motion_batch',
      payload: batch,
    });

    if (sendError !== 'ok') {
      res.status(502).json({ error: 'Failed to publish motion batch to realtime' });
      return;
    }

    res.status(202).json({ received: true, batchStartedAt: batch.batchStartedAt });
  },
);

// ─── DELETE /sessions/:id/leave ──────────────────────────────────────────────
// Called when the player exits the session (app background, disconnect, etc.).
// Removes their presence from the channel and logs the event.

sessionsRouter.delete('/:id/leave', async (req: Request, res: Response): Promise<void> => {
  const sessionId = req.params.id as string;
  const user      = req.user;

  await untrackPlayerPresence(sessionId, user.id);

  await supabase
    .schema('nota_games')
    .from('game_events')
    .insert({
      session_id: sessionId,
      player_id:  user.id,
      event_type: 'player_left',
      payload:    {},
    });

  res.status(200).json({ left: true });
});
