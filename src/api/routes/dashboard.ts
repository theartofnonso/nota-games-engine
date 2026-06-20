import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabase, supabaseForUser } from '../../lib/supabase.js';
import { getChannelName } from '../../realtime/channels.js';
import logger from '../../lib/logger.js';
import {
  getOrCreateSession,
  setChannel,
  updateGameState,
} from '../../sessions/session-registry.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import type { RuntimeGameState } from '../../types/session.js';

export const dashboardRouter = Router();

// All dashboard routes require authentication
dashboardRouter.use(requireAuth);

// ── POST /sessions ─────────────────────────────────────────────────────────
// Creates a new session row.  Called by the instructor dashboard before
// players are admitted.

const CreateSessionSchema = z.object({
  // Accept either 'title' (test/dashboard clients) or 'name' (direct API callers).
  // Both map to the sessions.name column.
  title:      z.string().min(1).optional(),
  name:       z.string().min(1).optional(),
  teamFormat: z.enum(['solo', 'team', 'mixed']).optional().default('solo'),
  // config is accepted for forward-compatibility but not yet persisted
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

    logger.info({ sessionId: data.id, name, teamFormat }, 'session created');
    res.status(201).json(data);
  },
);

// ── POST /sessions/:id/participants ───────────────────────────────────────
// Instructor pre-assigns a player to a session.  Only allowed while the
// session is still pending — after start the roster is locked.
// Service-role write; RLS does not apply.

const AddParticipantSchema = z.object({
  playerId:   z.string().uuid(),
  playerName: z.string().min(1),
  teamId:     z.string().uuid().optional(),
  duoId:      z.string().uuid().optional(),
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
        team_id:     body.teamId  ?? null,
        duo_id:      body.duoId   ?? null,
        assigned_by: body.teamId ? 'manual' : 'auto',
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
      duoId:      participant.duo_id  ?? null,
      joinedAt:   participant.joined_at,
    });
  },
);

// ── GET /sessions/:id/participants ───────────────────────────────────────
// Returns all pre-assigned participants for a session, including their
// resolved team and duo names.  Service-role read so instructors can see
// the full roster regardless of their own RLS scope.

dashboardRouter.get(
  '/:id/participants',
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.params.id as string;

    const { data, error } = await supabase
      .schema('nota_games')
      .from('session_participants')
      .select('*, teams(name, color), duos(name)')
      .eq('session_id', sessionId)
      .order('joined_at', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch participants', detail: error.message });
      return;
    }

    res.status(200).json({ sessionId, participants: data ?? [] });
  },
);

// ── PATCH /sessions/:id/state ──────────────────────────────────────────────
// Updates the session status in the DB and broadcasts the full RuntimeGameState
// to all connected players via the session:{id}:state Realtime channel.
//
// The caller (game controller / instructor UI) is the source of truth for the
// running game state; it sends the full current state so downstream subscribers
// stay in sync.

const SessionStateUpdateSchema = z.object({
  // DB-level status transition (optional — send without game state for simple
  // start/end transitions; send with game state to also broadcast to players)
  status: z.enum(['active', 'paused', 'ended']).optional(),

  // Full game state fields — all optional.
  // When 'phase' is present the full RuntimeGameState is broadcast to players.
  // When omitted only the DB status is updated (useful for pre-start or post-end).
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
        res
          .status(500)
          .json({ error: 'Failed to update session status', detail: dbError.message });
        return;
      }
    }

    // 2. Build and broadcast RuntimeGameState — only when 'phase' is provided.
    //    Simple status-only transitions (start/end) skip the broadcast; the
    //    instructor sends a full state update separately once the timer begins.
    let gameState: RuntimeGameState | null = null;

    if (body.phase !== undefined) {
      gameState = {
        timestamp: Date.now(),
        state: {
          phase:              body.phase,
          currentStation:     body.currentStation  ?? 1,
          currentRound:       body.currentRound    ?? 1,
          currentPass:        body.currentPass     ?? 1,
          timeRemaining:      body.timeRemaining   ?? 0,
          isRunning:          body.isRunning       ?? (body.status === 'active'),
          isPaused:           body.isPaused        ?? (body.status === 'paused'),
          completedIntervals: body.completedIntervals ?? 0,
          totalIntervals:     body.totalIntervals     ?? 0,
        },
      };

      // 3. Update local registry so in-flight motion batches use the new phase
      updateGameState(sessionId, gameState);

      // 4. Broadcast to all connected players on session:{id}:state.
      //    Reuse registry channel when available (set up by motion-subscriber.ts
      //    on first player join); create + subscribe lazily otherwise.
      const session = getOrCreateSession(sessionId);
      let stateChannel = session.stateChannel;

      if (!stateChannel) {
        stateChannel = supabase.channel(getChannelName('state', sessionId));
        stateChannel.subscribe();
        setChannel(sessionId, 'state', stateChannel);
      }

      await stateChannel.send({
        type:    'broadcast',
        event:   'session_state_change',
        payload: gameState,
      });

      logger.info({ sessionId, phase: gameState.state.phase, status: body.status ?? null }, 'session_state_change broadcast');
    }

    // 5. Append audit event (fire and forget)
    const eventType =
      body.status === 'active'  ? 'session_started'  :
      body.status === 'paused'  ? 'session_paused'   :
      body.status === 'ended'   ? 'session_ended'    :
      body.phase  === 'work'    ? 'pass_started'     :
      body.phase  === 'rest'    ? 'pass_ended'       :
                                  'session_resumed';

    supabase
      .schema('nota_games')
      .from('game_events')
      .insert({
        session_id:   sessionId,
        player_id:    req.user.id,
        event_type:   eventType,
        phase:        body.phase        ?? null,
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

    // Use user-scoped client — RLS on session_results restricts results
    // to sessions the caller participates in.
    const { data, error } = await supabaseForUser(req.jwt)
      .schema('nota_games')
      .rpc('get_leaderboard', {
        p_session_id: sessionId,
        p_pass:       pass,
      });

    if (error) {
      res
        .status(500)
        .json({ error: 'Failed to fetch leaderboard', detail: error.message });
      return;
    }

    res.status(200).json({ sessionId, pass, leaderboard: data ?? [] });
  },
);
