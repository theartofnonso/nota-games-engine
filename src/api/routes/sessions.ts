import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { supabase } from '../../lib/supabase.js';
import { subscribeToSession, scoreAndBroadcast } from '../../realtime/motion-subscriber.js';
import logger from '../../lib/logger.js';
import {
  getOrCreateSession,
  registerPlayer,
  removePlayer,
  setTeam,
  getTeamRecord,
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
// First-time join: assigns the player to whichever of the session's two teams
// has fewer members, then returns the assignment. The mobile app should persist
// playerId and use it on every subsequent call (/motion, /leave, re-join).
//
// Re-join (disconnect/reconnect): sends the same { playerId } received on first
// join. Existing team assignment is preserved.

const JoinSessionSchema = z.object({
  playerName: z.string().min(1),
  playerId:   z.string().uuid().optional(),
});

sessionsRouter.post(
  '/:id/join',
  validate(JoinSessionSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.params.id as string;
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
      .select('player_name, team_id')
      .eq('session_id', sessionId)
      .eq('player_id', playerId)
      .single();

    let participant = existing;
    const isRejoin  = !!existing;

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
        .select('player_name, team_id')
        .single();

      if (insertError || !inserted) {
        logger.error({ sessionId, playerId, err: insertError?.message }, 'failed to register participant');
        res.status(500).json({ error: 'Failed to register player', detail: insertError?.message });
        return;
      }

      logger.info({ sessionId, playerId, playerName }, 'participant self-registered');
      participant = inserted;
    }

    // Auto team assignment — only for first join and only when no team yet
    let teamId: string | undefined = participant.team_id ?? undefined;

    if (!isRejoin && !teamId) {
      const { data: teams } = await supabase
        .schema('nota_games')
        .from('teams')
        .select('id, name, color')
        .eq('session_id', sessionId);

      if (teams && teams.length > 0) {
        // Cache all team details while we have them
        for (const t of teams) setTeam(sessionId, t.id, t.name, t.color);

        // Count current members per team to find the smallest
        const { data: members } = await supabase
          .schema('nota_games')
          .from('session_participants')
          .select('team_id')
          .eq('session_id', sessionId)
          .not('team_id', 'is', null);

        const counts = new Map<string, number>(teams.map((t) => [t.id as string, 0]));
        for (const m of members ?? []) {
          if (m.team_id) counts.set(m.team_id, (counts.get(m.team_id) ?? 0) + 1);
        }

        const [assignedTeamId] = [...counts.entries()].sort((a, b) => a[1] - b[1])[0]!;

        await supabase
          .schema('nota_games')
          .from('session_participants')
          .update({ team_id: assignedTeamId, assigned_by: 'auto' })
          .eq('session_id', sessionId)
          .eq('player_id', playerId);

        teamId = assignedTeamId;
        logger.info({ sessionId, playerId, teamId }, 'player auto-assigned to team');
      }
    }

    // On re-join, team details may not be in the registry yet — fetch and cache if missing
    if (teamId && !getTeamRecord(sessionId, teamId)) {
      const { data: teamData } = await supabase
        .schema('nota_games')
        .from('teams')
        .select('name, color')
        .eq('id', teamId)
        .single();
      if (teamData) setTeam(sessionId, teamId, teamData.name, teamData.color);
    }

    // Cache player metadata in session registry (idempotent — safe on re-join)
    registerPlayer(sessionId, playerId, participant.player_name, teamId);

    // Ensure realtime subscription is active for this session (idempotent)
    const sessionRecord = getOrCreateSession(sessionId);
    subscribeToSession(sessionId);

    logger.info(
      { sessionId, playerId, playerName: participant.player_name, teamId: teamId ?? null, isRejoin },
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

    const teamRecord = teamId ? getTeamRecord(sessionId, teamId) : undefined;

    res.status(200).json({
      sessionId,
      playerId,
      playerName: participant.player_name,
      team: teamId
        ? { id: teamId, name: teamRecord?.name ?? null, color: teamRecord?.color ?? null }
        : null,
      isRejoin,
      gameState:  sessionRecord.gameState ?? null,
    });
  },
);

// ─── POST /sessions/:id/motion ────────────────────────────────────────────────
// Receives a PlayerMotionBatch from the mobile app, scores it immediately,
// and broadcasts the updated leaderboard to session:{id}:scores.

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

    await scoreAndBroadcast(sessionId, batch);

    logger.info({ sessionId, batch }, 'motion batch received');
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
