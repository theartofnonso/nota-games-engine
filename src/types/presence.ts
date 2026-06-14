// Payload tracked on the Supabase Presence channel per connected player.
// This is what the dashboard sees when it lists connected participants.

export interface PlayerPresence {
  playerId:   string;
  playerName: string;
  teamId:     string | null;
  duoId:      string | null;
  joinedAt:   number; // ms since epoch
}

// Payload broadcast on session:{id}:scores when the connected
// player list changes (join or leave).
export interface PresenceBroadcastPayload {
  sessionId:        string;
  connectedPlayers: PlayerPresence[];
  updatedAt:        number;
}
