import type { MotionSample } from '../types/motion.js';

// ── Tuning constants ──────────────────────────────────────────────────────────
// Adjust these to calibrate feel without touching the pipeline logic.

// Low-pass filter smoothing coefficient (0–1).
// Lower = more aggressive smoothing, fewer spikes.
// 0.3 at 20 Hz keeps exercise-frequency signals (~0–3 Hz) and cuts noise above that.
const LP_ALPHA = 0.3;

// Number of 5-second windows kept for the moving average.
// 4 windows = 20 seconds of history — scores build and fall over ~20 s.
const WINDOW_HISTORY_SIZE = 4;

// Scales smoothed RMS (m/s²) into XP.
// At 1.5 m/s² smoothed RMS → 75 XP/window; at 3 m/s² → caps out.
const XP_MULTIPLIER = 10;

// Hard ceiling per 5-second window regardless of effort.
const MAX_XP_PER_WINDOW = 30;

export { WINDOW_HISTORY_SIZE };

// ── Pipeline stages (pure functions) ─────────────────────────────────────────

// Stage 1 — vector magnitude per sample
export function calculateMagnitudes(samples: MotionSample[]): number[] {
  return samples.map((s) => Math.sqrt(s.x ** 2 + s.y ** 2 + s.z ** 2));
}

// Stage 2 — single-pole IIR low-pass filter
// Removes sensor noise, tiny jitters, and sudden spikes while preserving
// the sustained movement signal.
export function lowPassFilter(magnitudes: number[], alpha: number = LP_ALPHA): number[] {
  if (magnitudes.length === 0) return [];
  const out: number[] = [magnitudes[0]!];
  for (let i = 1; i < magnitudes.length; i++) {
    out.push(alpha * magnitudes[i]! + (1 - alpha) * out[i - 1]!);
  }
  return out;
}

// Stage 3 — Root Mean Square of filtered magnitudes
// Answers: how much work was performed during this window?
export function computeRMS(values: number[]): number {
  if (values.length === 0) return 0;
  const meanSquare = values.reduce((sum, v) => sum + v * v, 0) / values.length;
  return Math.sqrt(meanSquare);
}

// Stage 4 — arithmetic mean of the rolling window history
// Smooths scores across windows so they rise naturally over time.
export function movingAverage(history: number[]): number {
  if (history.length === 0) return 0;
  return history.reduce((sum, v) => sum + v, 0) / history.length;
}

// Stage 5 — convert smoothed effort signal to XP
export function toXp(smoothedRms: number): number {
  return Math.min(Math.max(0, smoothedRms * XP_MULTIPLIER), MAX_XP_PER_WINDOW);
}
