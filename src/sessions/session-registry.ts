import { SessionEngine } from '../game/session-engine.js';
import type { RuntimeGameState } from '../types/session.js';
import { supabase } from '../lib/supabase.js';

export interface TeamRecord {
  name:  string;
  color: string;
}

interface SessionRecord {
  engine:          SessionEngine;
  gameState:       RuntimeGameState | null;
  players:         Map<string, { playerName: string; teamId?: string }>;
  teams:           Map<string, TeamRecord>;
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
      teams:           new Map(),
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

export function updateGameState(sessionId: string, state: RuntimeGameState): void {
  const session = getOrCreateSession(sessionId);
  session.gameState = state;
}

export function registerPlayer(
  sessionId:  string,
  playerId:   string,
  playerName: string,
  teamId?:    string,
): void {
  const session = getOrCreateSession(sessionId);
  session.players.set(playerId, { playerName, teamId });
}

export function setTeam(sessionId: string, teamId: string, name: string, color: string): void {
  getOrCreateSession(sessionId).teams.set(teamId, { name, color });
}

export function getTeamRecord(sessionId: string, teamId: string): TeamRecord | undefined {
  return sessions.get(sessionId)?.teams.get(teamId);
}

export function removePlayer(sessionId: string, playerId: string): void {
  sessions.get(sessionId)?.players.delete(playerId);
}

export function removeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export async function cleanupSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;

  const channels = [
    session.scoresChannel,
    session.stateChannel,
    session.presenceChannel,
  ].filter((ch): ch is ReturnType<typeof supabase.channel> => ch !== null);

  await Promise.all(channels.map((ch) => supabase.removeChannel(ch)));
  sessions.delete(sessionId);
}

export function setChannel(
  sessionId: string,
  type: 'scores' | 'state' | 'presence',
  channel: ReturnType<typeof supabase.channel>,
): void {
  const session = getOrCreateSession(sessionId);
  if (type === 'scores')   session.scoresChannel   = channel;
  if (type === 'state')    session.stateChannel    = channel;
  if (type === 'presence') session.presenceChannel = channel;
}
