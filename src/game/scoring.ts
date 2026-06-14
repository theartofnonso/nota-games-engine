import type { PlayerMotionBatch } from '../types/motion.js';
import type { SessionPhase } from '../types/session.js';

// XP is only awarded during the work phase
const SCORING_PHASES: SessionPhase[] = ['work'];

// Tuning constants — adjust these to calibrate feel
const BASE_MULTIPLIER = 10;       // scales raw magnitude into XP
const REFERENCE_SAMPLE_RATE = 20; // Hz — the baseline device sample rate
const MAX_XP_PER_BATCH = 500;     // ceiling per 5-second batch

export function scoreBatch(
  batch: PlayerMotionBatch,
  currentPhase: SessionPhase
): number {
  // Award zero XP outside work phase — handles rest, passBreak, complete
  if (!SCORING_PHASES.includes(currentPhase)) return 0;

  const { samples, sampleRateHz } = batch;
  if (!samples.length) return 0;

  // Mean magnitude of linear acceleration across all samples
  const meanMagnitude =
    samples.reduce((sum, s) => {
      return sum + Math.sqrt(s.x ** 2 + s.y ** 2 + s.z ** 2);
    }, 0) / samples.length;

  // Normalise for sample rate: a 10 Hz batch and a 100 Hz batch with the
  // same motion should score the same. We scale by the ratio of actual
  // rate to the reference rate so denser batches aren't over-rewarded.
  const rateNormalisedMagnitude =
    meanMagnitude * (REFERENCE_SAMPLE_RATE / sampleRateHz);

  const rawXp = rateNormalisedMagnitude * BASE_MULTIPLIER;

  return Math.min(Math.max(0, rawXp), MAX_XP_PER_BATCH);
}
