import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabase, supabaseForUser } from '../../lib/supabase.js';
import { getChannelName } from '../../realtime/channels.js';
import logger from '../../lib/logger.js';
import {
  cleanupSession,
  getOrCreateSession,
  setChannel,
  updateGameState,
} from '../../sessions/session-registry.js';
import { requireAuth } from '../middleware/auth.js';
import { validate, validateUUIDParam } from '../middleware/validate.js';
import type { RuntimeGameState } from '../../types/session.js';

export const dashboardRouter = Router();

// All dashboard routes require authentication
dashboardRouter.use(requireAuth);

// Reject non-UUID session IDs at the router boundary before any handler runs
dashboardRouter.param('id', validateUUIDParam);

// ── POST /sessions ─────────────────────────────────────────────────────────
// Creates a new session row and auto-creates two teams (Red and Blue).

const CreateSessionSchema = z.object({
  title:      z.string().min(1).optional(),
  name:       z.string().min(1).optional(),
  teamFormat: z.enum(['solo', 'team', 'mixed']).optional().default('solo'),
  config:     z.object({}).passthrough().optional(),
}).refine(
  (d) => d.title !== undefined || d.name !== undefined,
  { message: 'Either title or name is required' },
);

dashboardRouter.post(
  '/',
  validate(CreateSessionSchema),
  async (req: Request, res: Response): Promise<void> => {
    const body       = req.body as z.infer<typeof CreateSessionSchema>;
    const name       = (body.title ?? body.name)!;
    const teamFormat = body.teamFormat ?? 'solo';

    const { data, error } = await supabase
      .schema('nota_games')
      .from('sessions')
      .insert({
        name,
        team_format: teamFormat,
        status:      'pending',
        created_by:  req.user.id,
      })
      .select()
      .single();

    if (error) {
      logger.error({ err: error.message, name, teamFormat }, 'failed to create session');
      res.status(500).json({ error: 'Failed to create session', detail: error.message });
      return;
    }

    // Auto-create Red and Blue teams for the session
    const { error: teamsError } = await supabase
      .schema('nota_games')
      .from('teams')
      .insert([
        { session_id: data.id, name: 'Red'  },
        { session_id: data.id, name: 'Blue' },
      ]);

    if (teamsError) {
      logger.warn({ sessionId: data.id, err: teamsError.message }, 'failed to auto-create teams');
    }

    logger.info({ sessionId: data.id, name, teamFormat }, 'session created');
    res.status(201).json(data);
  },
);

// ── POST /sessions/:id/participants ───────────────────────────────────────
// Instructor pre-registers a player before they join. Team assignment happens
// automatically when the player calls /join — not here.

const AddParticipantSchema = z.object({
  playerId:   z.string().uuid(),
  playerName: z.string().min(1),
});
type AddParticipantBody = z.infer<typeof AddParticipantSchema>;

dashboardRouter.post(
  '/:id/participants',
  validate(AddParticipantSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.params.id as string;
    const body      = req.body as AddParticipantBody;

    // Confirm session exists and is still pending
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

    if (session.status !== 'pending') {
      res.status(409).json({
        error: 'Cannot add participants after session has started',
        status: session.status,
      });
      return;
    }

    const { data: participant, error } = await supabase
      .schema('nota_games')
      .from('session_participants')
      .insert({
        session_id:  sessionId,
        player_id:   body.playerId,
        player_name: body.playerName,
        assigned_by: 'auto',
      })
      .select()
      .single();

    if (error || !participant) {
      if (error?.code === '23505') {
        res.status(409).json({ error: 'Player already registered for this session' });
        return;
      }
      res.status(500).json({ error: 'Failed to add participant', detail: error?.message });
      return;
    }

    res.status(201).json({
      id:         participant.id,
      playerId:   participant.player_id,
      playerName: participant.player_name,
      teamId:     participant.team_id ?? null,
      joinedAt:   participant.joined_at,
    });
  },
);

// ── GET /sessions/:id/participants ───────────────────────────────────────
// Returns all participants for a session with their resolved team name.

dashboardRouter.get(
  '/:id/participants',
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.params.id as string;

    const { data: participants, error } = await supabase
      .schema('nota_games')
      .from('session_participants')
      .select('*')
      .eq('session_id', sessionId)
      .order('joined_at', { ascending: true });

    if (error) {
      logger.error({ sessionId, err: error.message }, 'failed to fetch participants');
      res.status(500).json({ error: 'Failed to fetch participants', detail: error.message });
      return;
    }

    if (!participants || participants.length === 0) {
      res.status(200).json({ sessionId, participants: [] });
      return;
    }

    const teamIds = [...new Set(participants.map((p) => p.team_id).filter(Boolean))];

    const teamsResult = teamIds.length > 0
      ? await supabase.schema('nota_games').from('teams').select('id, name').in('id', teamIds)
      : { data: [] };

    const teamMap = new Map((teamsResult.data ?? []).map((t: { id: string; name: string }) => [t.id, t.name]));

    const enriched = participants.map((p) => ({
      ...p,
      teams: p.team_id ? { name: teamMap.get(p.team_id) ?? null } : null,
    }));

    logger.debug({ sessionId, count: enriched.length }, 'participants fetched');
    res.status(200).json({ sessionId, participants: enriched });
  },
);

// ── PATCH /sessions/:id/state ──────────────────────────────────────────────
// Updates the session status in the DB and broadcasts the full RuntimeGameState
// to all connected players via the session:{id}:state Realtime channel.

const SessionStateUpdateSchema = z.object({
  status: z.enum(['active', 'paused', 'ended']).optional(),
  phase:              z.enum(['work', 'rest', 'passBreak', 'complete']).optional(),
  currentStation:     z.number().int().min(1).optional(),
  currentRound:       z.number().int().min(1).optional(),
  currentPass:        z.number().int().min(1).optional(),
  timeRemaining:      z.number().min(0).optional(),
  isRunning:          z.boolean().optional(),
  isPaused:           z.boolean().optional(),
  completedIntervals: z.number().int().min(0).optional(),
  totalIntervals:     z.number().int().min(0).optional(),
});

dashboardRouter.patch(
  '/:id/state',
  validate(SessionStateUpdateSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.params.id as string;
    const body = req.body as z.infer<typeof SessionStateUpdateSchema>;

    // 1. Persist status/timestamp change to the DB when explicitly provided
    if (body.status) {
      const dbUpdate: Record<string, unknown> = { status: body.status };
      if (body.currentPass !== undefined) dbUpdate['current_pass'] = body.currentPass;
      if (body.status === 'active') dbUpdate['started_at'] = new Date().toISOString();
      if (body.status === 'ended')  dbUpdate['ended_at']   = new Date().toISOString();

      const { error: dbError } = await supabase
        .schema('nota_games')
        .from('sessions')
        .update(dbUpdate)
        .eq('id', sessionId);

      if (dbError) {
        res.status(500).json({ error: 'Failed to update session status', detail: dbError.message });
        return;
      }
    }

    // 2. Build and broadcast RuntimeGameState when a phase is present.
    //    When status === 'ended' and no phase was given, synthesise 'complete'
    //    so devices always receive a disconnect signal.
    const effectivePhase = body.phase ?? (body.status === 'ended' ? 'complete' : undefined);
    let gameState: RuntimeGameState | null = null;

    if (effectivePhase !== undefined) {
      const resolvedIsPaused = body.isPaused ?? (body.status === 'paused');

      gameState = {
        timestamp: Date.now(),
        state: {
          phase:              effectivePhase,
          currentStation:     body.currentStation  ?? 1,
          currentRound:       body.currentRound    ?? 1,
          currentPass:        body.currentPass     ?? 1,
          timeRemaining:      body.timeRemaining   ?? 0,
          isRunning:          body.isRunning       ?? (body.status === 'active'),
          isPaused:           resolvedIsPaused,
          completedIntervals: body.completedIntervals ?? 0,
          totalIntervals:     body.totalIntervals     ?? 0,
          sensorActive: effectivePhase === 'work' && !resolvedIsPaused,
          sessionEnded: effectivePhase === 'complete',
        },
      };

      updateGameState(sessionId, gameState);

      const session = getOrCreateSession(sessionId);
      let stateChannel = session.stateChannel;

      if (!stateChannel) {
        stateChannel = supabase.channel(getChannelName('state', sessionId));
        setChannel(sessionId, 'state', stateChannel);
      }

      await stateChannel.httpSend('session_state_change', gameState);

      logger.info({ sessionId, phase: gameState.state.phase, status: body.status ?? null }, 'session_state_change broadcast');
    }

    if (body.status === 'ended') {
      await cleanupSession(sessionId);
      logger.info({ sessionId }, 'session cleaned up');
    }

    // Append audit event (fire and forget)
    const eventType =
      body.status === 'active'       ? 'session_started'  :
      body.status === 'paused'       ? 'session_paused'   :
      body.status === 'ended'        ? 'session_ended'    :
      effectivePhase === 'work'      ? 'pass_started'     :
      effectivePhase === 'rest'      ? 'pass_ended'       :
                                       'session_resumed';

    supabase
      .schema('nota_games')
      .from('game_events')
      .insert({
        session_id:   sessionId,
        player_id:    req.user.id,
        event_type:   eventType,
        phase:        effectivePhase    ?? null,
        current_pass: body.currentPass  ?? null,
        payload: {
          status:    body.status    ?? null,
          isRunning: body.isRunning ?? null,
          isPaused:  body.isPaused  ?? null,
        },
      })
      .then(({ error }) => {
        if (error) logger.error({ sessionId, err: error.message }, 'state event log failed');
      });

    res.status(200).json({ updated: true, gameState });
  },
);

// ── GET /sessions/:id/leaderboard ─────────────────────────────────────────
// Returns the ranked leaderboard for a session.
// Optional ?pass=N query param returns per-pass rankings for pass N.

dashboardRouter.get(
  '/:id/leaderboard',
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.params.id as string;
    const passParam = req.query['pass'];
    const pass      = passParam !== undefined ? parseInt(passParam as string, 10) : null;

    if (pass !== null && (isNaN(pass) || pass < 1)) {
      res.status(400).json({ error: 'pass query param must be a positive integer' });
      return;
    }

    const { data, error } = await supabaseForUser(req.jwt)
      .schema('nota_games')
      .rpc('get_leaderboard', {
        p_session_id: sessionId,
        p_pass:       pass,
      });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch leaderboard', detail: error.message });
      return;
    }

    res.status(200).json({ sessionId, pass, leaderboard: data ?? [] });
  },
);
