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
  updatePlayerTeam,
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

    // Fetch participants first, then resolve team/duo names in a second query.
    // Embedding teams(name) directly in a custom schema select causes PostgREST
    // to silently return empty results when FK relationships can't be resolved.
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

    logger.debug({ sessionId, count: participants?.length ?? 0 }, 'participants fetched');

    if (!participants || participants.length === 0) {
      res.status(200).json({ sessionId, participants: [] });
      return;
    }

    // Resolve team and duo names for participants that have assignments
    const teamIds = [...new Set(participants.map((p) => p.team_id).filter(Boolean))];
    const duoIds  = [...new Set(participants.map((p) => p.duo_id).filter(Boolean))];

    const [teamsResult, duosResult] = await Promise.all([
      teamIds.length > 0
        ? supabase.schema('nota_games').from('teams').select('id, name').in('id', teamIds)
        : Promise.resolve({ data: [] }),
      duoIds.length > 0
        ? supabase.schema('nota_games').from('duos').select('id, name').in('id', duoIds)
        : Promise.resolve({ data: [] }),
    ]);

    const teamMap = new Map((teamsResult.data ?? []).map((t: { id: string; name: string }) => [t.id, t.name]));
    const duoMap  = new Map((duosResult.data  ?? []).map((d: { id: string; name: string }) => [d.id, d.name]));

    const enriched = participants.map((p) => ({
      ...p,
      teams: p.team_id ? { name: teamMap.get(p.team_id) ?? null } : null,
      duos:  p.duo_id  ? { name: duoMap.get(p.duo_id)   ?? null } : null,
    }));

    res.status(200).json({ sessionId, participants: enriched });
  },
);

// ── POST /sessions/:id/participants/assign ────────────────────────────────
// Auto-assigns all unassigned participants to the session's teams using
// round-robin distribution (smallest team first).
// Requires at least one team to exist for the session.
// Updates the in-memory registry for any players already in the session.

dashboardRouter.post(
  '/:id/participants/assign',
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.params.id as string;

    // Fetch teams with their current participant counts
    const { data: teams, error: teamsError } = await supabase
      .schema('nota_games')
      .from('teams')
      .select('id, name, session_participants(count)')
      .eq('session_id', sessionId);

    if (teamsError) {
      res.status(500).json({ error: 'Failed to fetch teams', detail: teamsError.message });
      return;
    }

    if (!teams || teams.length === 0) {
      res.status(409).json({ error: 'No teams exist for this session. Create teams before assigning.' });
      return;
    }

    // Fetch unassigned participants
    const { data: unassigned, error: participantsError } = await supabase
      .schema('nota_games')
      .from('session_participants')
      .select('id, player_id')
      .eq('session_id', sessionId)
      .is('team_id', null);

    if (participantsError) {
      res.status(500).json({ error: 'Failed to fetch participants', detail: participantsError.message });
      return;
    }

    if (!unassigned || unassigned.length === 0) {
      res.status(200).json({ assigned: 0, message: 'All participants already have a team' });
      return;
    }

    // Sort teams by current size ascending so we fill the smallest teams first
    const teamCounts = teams.map((t) => ({
      id:    t.id as string,
      name:  t.name as string,
      count: (t.session_participants as { count: number }[])[0]?.count ?? 0,
    }));
    teamCounts.sort((a, b) => a.count - b.count);

    // Round-robin assign
    const assignments: { participantId: string; playerId: string; teamId: string }[] = [];
    unassigned.forEach((participant, i) => {
      const team = teamCounts[i % teamCounts.length]!;
      assignments.push({ participantId: participant.id as string, playerId: participant.player_id as string, teamId: team.id });
      team.count++;
    });

    // Bulk update — one update per unique team to minimise round-trips
    const updatesByTeam = new Map<string, string[]>();
    for (const a of assignments) {
      const ids = updatesByTeam.get(a.teamId) ?? [];
      ids.push(a.participantId);
      updatesByTeam.set(a.teamId, ids);
    }

    for (const [teamId, ids] of updatesByTeam) {
      const { error: updateError } = await supabase
        .schema('nota_games')
        .from('session_participants')
        .update({ team_id: teamId, assigned_by: 'auto' })
        .in('id', ids);

      if (updateError) {
        logger.error({ sessionId, teamId, err: updateError.message }, 'auto-assign update failed');
        res.status(500).json({ error: 'Failed to assign teams', detail: updateError.message });
        return;
      }
    }

    // Propagate to in-memory registry for any players already in the session
    for (const a of assignments) {
      updatePlayerTeam(sessionId, a.playerId, a.teamId, undefined);
    }

    logger.info({ sessionId, assigned: assignments.length }, 'auto team assignment complete');
    res.status(200).json({ assigned: assignments.length });
  },
);

// ── PATCH /sessions/:id/participants ─────────────────────────────────────
// Bulk manual assignment — assign multiple participants to teams in one call.
// Each entry in the assignments array is applied independently; a single DB
// error aborts the whole operation and returns a 500 with the failing entry.
// Updates the in-memory registry and session_results for all affected players.

const BulkAssignItemSchema = z.object({
  participantId: z.string().uuid(),
  teamId:        z.string().uuid().nullable(),
  duoId:         z.string().uuid().nullable().optional(),
}).refine(
  (d) => !(d.duoId && !d.teamId),
  { message: 'duoId requires a teamId' },
);

const BulkAssignSchema = z.object({
  assignments: z.array(BulkAssignItemSchema).min(1),
});

dashboardRouter.patch(
  '/:id/participants',
  validate(BulkAssignSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sessionId  = req.params.id as string;
    const { assignments } = req.body as z.infer<typeof BulkAssignSchema>;

    // Group by (teamId, duoId) so participants sharing the same assignment
    // get a single UPDATE instead of one per participant.
    type GroupKey = string; // `${teamId}:${duoId}`
    const groups = new Map<GroupKey, { teamId: string | null; duoId: string | null; ids: string[] }>();

    for (const a of assignments) {
      const teamId = a.teamId ?? null;
      const duoId  = teamId ? (a.duoId ?? null) : null; // clear duo if team cleared
      const key: GroupKey = `${teamId}:${duoId}`;
      const group = groups.get(key) ?? { teamId, duoId, ids: [] };
      group.ids.push(a.participantId);
      groups.set(key, group);
    }

    // Apply each group as a single UPDATE
    for (const { teamId, duoId, ids } of groups.values()) {
      const { error: updateError } = await supabase
        .schema('nota_games')
        .from('session_participants')
        .update({ team_id: teamId, duo_id: duoId, assigned_by: 'manual' })
        .in('id', ids)
        .eq('session_id', sessionId);

      if (updateError) {
        logger.error({ sessionId, teamId, duoId, ids, err: updateError.message }, 'bulk assign update failed');
        res.status(500).json({ error: 'Bulk assignment failed', detail: updateError.message });
        return;
      }
    }

    // Fetch the updated rows to return accurate state and propagate to registry
    const { data: updated, error: fetchError } = await supabase
      .schema('nota_games')
      .from('session_participants')
      .select('id, player_id, player_name, team_id, duo_id')
      .in('id', assignments.map((a) => a.participantId))
      .eq('session_id', sessionId);

    if (fetchError || !updated) {
      res.status(500).json({ error: 'Assignment applied but failed to fetch results', detail: fetchError?.message });
      return;
    }

    // Propagate to in-memory registry and session_results
    for (const p of updated) {
      updatePlayerTeam(sessionId, p.player_id as string, p.team_id ?? undefined, p.duo_id ?? undefined);

      await supabase
        .schema('nota_games')
        .from('session_results')
        .update({ team_id: p.team_id, duo_id: p.duo_id })
        .eq('session_id', sessionId)
        .eq('player_id', p.player_id);
    }

    logger.info({ sessionId, count: updated.length }, 'bulk manual team assignment complete');

    res.status(200).json({
      assigned: updated.length,
      participants: updated.map((p) => ({
        id:         p.id,
        playerId:   p.player_id,
        playerName: p.player_name,
        teamId:     p.team_id  ?? null,
        duoId:      p.duo_id   ?? null,
      })),
    });
  },
);

// ── PATCH /sessions/:id/participants/:participantId ───────────────────────
// Manually assigns a single participant to a team (and optionally a duo).
// Clears duo assignment if teamId is set to null.
// Updates the in-memory registry if the player is currently in the session.

const ManualAssignSchema = z.object({
  teamId: z.string().uuid().nullable(),
  duoId:  z.string().uuid().nullable().optional(),
}).refine(
  (d) => !(d.duoId && !d.teamId),
  { message: 'duoId requires a teamId' },
);

dashboardRouter.patch(
  '/:id/participants/:participantId',
  validate(ManualAssignSchema),
  async (req: Request, res: Response): Promise<void> => {
    const sessionId     = req.params.id as string;
    const participantId = req.params.participantId as string;
    const body          = req.body as z.infer<typeof ManualAssignSchema>;

    const teamId = body.teamId;
    const duoId  = body.teamId ? (body.duoId ?? null) : null; // clear duo if team cleared

    const { data: participant, error } = await supabase
      .schema('nota_games')
      .from('session_participants')
      .update({
        team_id:     teamId,
        duo_id:      duoId,
        assigned_by: 'manual',
      })
      .eq('id', participantId)
      .eq('session_id', sessionId)
      .select('player_id, player_name, team_id, duo_id')
      .single();

    if (error || !participant) {
      res.status(error ? 500 : 404).json({ error: 'Failed to update participant', detail: error?.message });
      return;
    }

    // Propagate to in-memory registry if player is currently in the session
    updatePlayerTeam(
      sessionId,
      participant.player_id as string,
      participant.team_id   ?? undefined,
      participant.duo_id    ?? undefined,
    );

    // Keep session_results in sync if a score row already exists
    await supabase
      .schema('nota_games')
      .from('session_results')
      .update({ team_id: teamId, duo_id: duoId })
      .eq('session_id', sessionId)
      .eq('player_id', participant.player_id);

    logger.info(
      { sessionId, participantId, playerId: participant.player_id, teamId, duoId },
      'manual team assignment',
    );

    res.status(200).json({
      id:         participantId,
      playerId:   participant.player_id,
      playerName: participant.player_name,
      teamId:     participant.team_id  ?? null,
      duoId:      participant.duo_id   ?? null,
    });
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

    // 2. Build and broadcast RuntimeGameState.
    //    When 'phase' is explicitly provided, use it as-is.
    //    When status === 'ended' and no phase was given, synthesise 'complete'
    //    so devices always receive a disconnect signal — never silently stranded.
    //    Simple non-end status-only transitions (e.g. 'active' alone at start)
    //    skip the broadcast; the controller sends a full state separately.
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
          // Binary signals so the sensor client needs no game-state knowledge
          sensorActive: effectivePhase === 'work' && !resolvedIsPaused,
          sessionEnded: effectivePhase === 'complete',
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
        setChannel(sessionId, 'state', stateChannel);
      }

      await stateChannel.httpSend('session_state_change', gameState);

      logger.info({ sessionId, phase: gameState.state.phase, status: body.status ?? null }, 'session_state_change broadcast');
    }

    // 3b. Tear down Realtime channels and remove from registry after the
    //     broadcast resolves. Subsequent /motion calls will find no players
    //     in the new empty record and return 403.
    if (body.status === 'ended') {
      await cleanupSession(sessionId);
      logger.info({ sessionId }, 'session cleaned up');
    }

    // 5. Append audit event (fire and forget)
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
        phase:        effectivePhase      ?? null,
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
