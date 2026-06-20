import { supabase } from '../lib/supabase.js';
import { getChannelName } from './channels.js';
import logger from '../lib/logger.js';
import { getOrCreateSession, setChannel } from '../sessions/session-registry.js';
import type { PlayerPresence, PresenceBroadcastPayload } from '../types/presence.js';

export function trackPlayerPresence(
  sessionId:  string,
  playerId:   string,
  playerName: string,
  teamId:     string | null,
  duoId:      string | null,
): void {
  const session = getOrCreateSession(sessionId);

  // Reuse existing presence channel if already created for this session
  let presenceChannel = session.presenceChannel;

  if (!presenceChannel) {
    // Use a dedicated presence channel, not the motion channel.
    // supabase.channel() returns the same object for the same name — if we
    // reused 'motion' here, we'd try to add presence callbacks to an already-
    // subscribed channel, which Realtime forbids (error 42P17 equivalent).
    presenceChannel = supabase.channel(getChannelName('presence', sessionId), {
      config: { presence: { key: sessionId } },
    });

    presenceChannel
      .on('presence', { event: 'sync' }, () => {
        // Full presence state re-synced — broadcast updated player list
        _broadcastPresence(sessionId, presenceChannel!);
      })
      .on('presence', { event: 'join' }, ({ newPresences }) => {
        logger.info({ sessionId, presences: newPresences }, 'player presence joined');
      })
      .on('presence', { event: 'leave' }, ({ leftPresences }) => {
        logger.info({ sessionId, presences: leftPresences }, 'player presence left');
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          // Track this player's presence once the channel is ready
          await presenceChannel!.track({
            playerId,
            playerName,
            teamId,
            duoId,
            joinedAt: Date.now(),
          } satisfies PlayerPresence);
        }
      });

    setChannel(sessionId, 'presence', presenceChannel);
  } else {
    // Channel already exists — just track the new player
    presenceChannel.track({
      playerId,
      playerName,
      teamId,
      duoId,
      joinedAt: Date.now(),
    } satisfies PlayerPresence);
  }
}

export async function untrackPlayerPresence(
  sessionId: string,
  playerId:  string,
): Promise<void> {
  const session = getOrCreateSession(sessionId);
  if (!session.presenceChannel) return;
  await session.presenceChannel.untrack();
  logger.info({ sessionId, playerId }, 'player presence untracked');
}

// Reads the current presence state and broadcasts the connected
// player list to the scores channel so the dashboard stays in sync.
function _broadcastPresence(
  sessionId:       string,
  presenceChannel: ReturnType<typeof supabase.channel>,
): void {
  const state   = presenceChannel.presenceState<PlayerPresence>();
  const players = Object.values(state).flat();

  const session = getOrCreateSession(sessionId);
  let scoresChannel = session.scoresChannel;
  if (!scoresChannel) {
    scoresChannel = supabase.channel(getChannelName('scores', sessionId));
    scoresChannel.subscribe();
    setChannel(sessionId, 'scores', scoresChannel);
  }

  const payload: PresenceBroadcastPayload = {
    sessionId,
    connectedPlayers: players,
    updatedAt:        Date.now(),
  };

  scoresChannel.send({
    type:    'broadcast',
    event:   'presence_update',
    payload,
  });
}
