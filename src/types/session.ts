export type SessionStatus = 'pending' | 'active' | 'paused' | 'pass_break' | 'ended';

export type SessionPhase = 'work' | 'rest' | 'passBreak' | 'complete';

export interface LeaderboardEntry {
  playerId: string;
  total_xp: number;
  rank: number;
}

export interface RuntimeGameState {
  timestamp: number;
  state: {
    phase: SessionPhase;
    currentStation: number;
    currentRound: number;
    currentPass: number;
    timeRemaining: number;
    isRunning: boolean;
    isPaused: boolean;
    completedIntervals: number;
    totalIntervals: number;
    startedAtMs?: number;
    endedAtMs?: number;
    // Derived signals for the sensor client — no game-state interpretation needed
    sensorActive: boolean; // true = send motion batches; false = stop
    sessionEnded: boolean; // true = call /leave and show results
  };
}

// Scored result emitted after a batch is processed
export interface ScoredBatch {
  sessionId: string;
  playerId: string;
  playerName: string;
  xpDelta: number;
  totalXp: number;
  currentPass: number;
  timestamp: number;
}

// Payload broadcast on session:{id}:scores
export interface ScoresBroadcastPayload {
  sessionId: string;
  updatedAt: number;
  leaderboard: (LeaderboardEntry & {
    playerName: string;
  })[];
}
