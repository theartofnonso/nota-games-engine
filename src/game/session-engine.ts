import type { LeaderboardEntry, SessionPhase } from '../types/session.js';
import type { PlayerMotionBatch } from '../types/motion.js';
import {
  calculateMagnitudes,
  lowPassFilter,
  computeRMS,
  movingAverage,
  toXp,
  WINDOW_HISTORY_SIZE,
} from './scoring.js';

// XP is only awarded during the work phase
const SCORING_PHASES: SessionPhase[] = ['work'];

interface PlayerState {
  totalXp:       number;
  windowHistory: number[]; // per-window RMS values, capped at WINDOW_HISTORY_SIZE
}

export class SessionEngine {
  private players = new Map<string, PlayerState>();

  private getOrCreate(playerId: string): PlayerState {
    if (!this.players.has(playerId)) {
      this.players.set(playerId, { totalXp: 0, windowHistory: [] });
    }
    return this.players.get(playerId)!;
  }

  // Full pipeline for one 5-second batch:
  //   magnitudes → low-pass filter → RMS → moving average → XP
  //
  // Window history is NOT updated when paused — caller should skip this
  // call entirely when state.isPaused is true.
  // Returns the XP delta awarded (0 outside scoring phases or empty batch).
  processMotionBatch(
    playerId: string,
    batch:    PlayerMotionBatch,
    phase:    SessionPhase,
  ): number {
    if (!SCORING_PHASES.includes(phase)) return 0;
    if (!batch.samples.length) return 0;

    const player = this.getOrCreate(playerId);

    const magnitudes  = calculateMagnitudes(batch.samples);
    const filtered    = lowPassFilter(magnitudes);
    const windowRms   = computeRMS(filtered);

    player.windowHistory.push(windowRms);
    if (player.windowHistory.length > WINDOW_HISTORY_SIZE) {
      player.windowHistory.shift();
    }

    const xpDelta = toXp(movingAverage(player.windowHistory));
    player.totalXp = Math.max(0, player.totalXp + xpDelta);
    return xpDelta;
  }

  getPlayerXp(playerId: string): number {
    return this.players.get(playerId)?.totalXp ?? 0;
  }

  getTotalScore(): number {
    let total = 0;
    for (const state of this.players.values()) total += state.totalXp;
    return total;
  }

  getLeaderboard(): LeaderboardEntry[] {
    return Array.from(this.players.entries())
      .map(([playerId, state]) => ({ playerId, total_xp: state.totalXp }))
      .sort((a, b) => b.total_xp - a.total_xp)
      .map((entry, index) => ({ ...entry, rank: index + 1 }));
  }

  reset(): void {
    this.players.clear();
  }
}
