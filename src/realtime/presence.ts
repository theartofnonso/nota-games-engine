import { supabase } from '../lib/supabase.js';
import { getChannelName } from './channels.js';
import logger from '../lib/logger.js';
import { getOrCreateSession, setChannel } from '../sessions/session-registry.js';
import type { PlayerPresence, PresenceBroadcastPayload } from '../types/presence.js';

// Subscribes the server to the session's presence channel as a passive listener.
//
// Mobile clients call channel.track() from their own Supabase connection.
// When a client connects, Supabase fires 'join'. When their WebSocket drops
// (app close, network loss, explicit untrack), Supabase fires 'leave'.
//
// The server listens for all three events ('sync', 'join', 'leave') and
// re-broadcasts the full connected player list to session:{id}:scores so the
// controller stays in sync in real time without polling.
export function subscribeToPresence(sessionId: string): void {
  const session = getOrCreateSession(sessionId);
  if (session.presenceChannel) return; // already set up for this session

  const presenceChannel = supabase.channel(getChannelName('presence', sessionId));

  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      logger.info({ sessionId }, 'presence sync');
      _broadcastPresence(sessionId, presenceChannel);
    })
    .on('presence', { event: 'join' }, ({ newPresences }) => {
      logger.info({ sessionId, presences: newPresences }, 'player presence joined');
      _broadcastPresence(sessionId, presenceChannel);
    })
    .on('presence', { event: 'leave' }, ({ leftPresences }) => {
      logger.info({ sessionId, presences: leftPresences }, 'player presence left');
      _broadcastPresence(sessionId, presenceChannel);
    })
    .subscribe();

  setChannel(sessionId, 'presence', presenceChannel);
}

// Reads the current presence state and broadcasts the full connected-player
// list to session:{id}:scores so the controller and scoreboard stay in sync.
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
    setChannel(sessionId, 'scores', scoresChannel);
  }

  const payload: PresenceBroadcastPayload = {
    sessionId,
    connectedPlayers: players,
    updatedAt:        Date.now(),
  };

  scoresChannel.httpSend('presence_update', payload).catch((err: unknown) => {
    logger.error({ sessionId, err }, 'presence_update broadcast failed');
  });
}
