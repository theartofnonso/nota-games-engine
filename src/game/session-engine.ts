import type { LeaderboardEntry } from '../types/session.js';

export class SessionEngine {
  private players = new Map<string, number>();

  updatePlayer(playerId: string, xpDelta: number): void {
    const current = this.players.get(playerId) ?? 0;
    this.players.set(playerId, Math.max(0, current + xpDelta));
  }

  getPlayerXp(playerId: string): number {
    return this.players.get(playerId) ?? 0;
  }

  getTotalScore(): number {
    let total = 0;
    for (const xp of this.players.values()) total += xp;
    return total;
  }

  getLeaderboard(): LeaderboardEntry[] {
    return Array.from(this.players.entries())
      .map(([playerId, total_xp]) => ({ playerId, total_xp }))
      .sort((a, b) => b.total_xp - a.total_xp)
      .map((entry, index) => ({ ...entry, rank: index + 1 }));
  }

  reset(): void {
    this.players.clear();
  }
}
