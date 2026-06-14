export interface MotionSample {
  timestamp: number;
  x: number;
  y: number;
  z: number;
}

export interface PlayerMotionBatch {
  sessionId: string;

  /** Absent for solo-format sessions. */
  teamId?: string;

  playerId: string;
  playerName: string;

  batchStartedAt: number;
  batchEndedAt: number;

  sampleRateHz: number;

  samples: MotionSample[];
}

// ─── Zod schemas for runtime validation of incoming API payloads ──────────────

import { z } from 'zod';

export const MotionSampleSchema = z.object({
  timestamp: z.number().int(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const PlayerMotionBatchSchema = z.object({
  playerId:       z.string().uuid(),
  playerName:     z.string().min(1),
  batchStartedAt: z.number().int(),
  batchEndedAt:   z.number().int(),
  sampleRateHz:   z.number().min(1),
  samples:        z.array(MotionSampleSchema).min(1),
});