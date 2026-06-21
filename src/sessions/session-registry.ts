import { SessionEngine } from '../game/session-engine.js';
import type { RuntimeGameState } from '../types/session.js';
import { supabase } from '../lib/supabase.js';

interface SessionRecord {
  engine:          SessionEngine;
  gameState:       RuntimeGameState | null;
  // player metadata needed for leaderboard broadcasts
  players:         Map<string, { playerName: string; teamId?: string; duoId?: string }>;
  motionChannel:   ReturnType<typeof supabase.channel> | null;
  scoresChannel:   ReturnType<typeof supabase.channel> | null;
  stateChannel:    ReturnType<typeof supabase.channel> | null;
  presenceChannel: ReturnType<typeof supabase.channel> | null;
}

const sessions = new Map<string, SessionRecord>();

export function getOrCreateSession(sessionId: string): SessionRecord {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      engine:          new SessionEngine(),
      gameState:       null,
      players:         new Map(),
      motionChannel:   null,
      scoresChannel:   null,
      stateChannel:    null,
      presenceChannel: null,
    });
  }
  return sessions.get(sessionId)!;
}

export function getSession(sessionId: string): SessionRecord | undefined {
  return sessions.get(sessionId);
}

export function updateGameState(
  sessionId: string,
  state: RuntimeGameState
): void {
  const session = getOrCreateSession(sessionId);
  session.gameState = state;
}

export function registerPlayer(
  sessionId: string,
  playerId: string,
  playerName: string,
  teamId?: string,
  duoId?: string
): void {
  const session = getOrCreateSession(sessionId);
  session.players.set(playerId, { playerName, teamId, duoId });
}

export function removePlayer(sessionId: string, playerId: string): void {
  sessions.get(sessionId)?.players.delete(playerId);
}

export function updatePlayerTeam(
  sessionId: string,
  playerId:  string,
  teamId:    string | undefined,
  duoId:     string | undefined,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  const player = session.players.get(playerId);
  if (!player) return;
  session.players.set(playerId, { ...player, teamId, duoId });
}

export function removeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

// Unsubscribes all Realtime channels for a session and removes it from the
// registry. Call this after the final session_state_change broadcast so that
// subsequent motion batches are rejected (no players in the new empty record).
export async function cleanupSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;

  const channels = [
    session.motionChannel,
    session.scoresChannel,
    session.stateChannel,
    session.presenceChannel,
  ].filter((ch): ch is ReturnType<typeof supabase.channel> => ch !== null);

  await Promise.all(channels.map((ch) => supabase.removeChannel(ch)));
  sessions.delete(sessionId);
}

export function setChannel(
  sessionId: string,
  type: 'motion' | 'scores' | 'state' | 'presence',
  channel: ReturnType<typeof supabase.channel>,
): void {
  const session = getOrCreateSession(sessionId);
  if (type === 'motion')   session.motionChannel   = channel;
  if (type === 'scores')   session.scoresChannel   = channel;
  if (type === 'state')    session.stateChannel    = channel;
  if (type === 'presence') session.presenceChannel = channel;
}
