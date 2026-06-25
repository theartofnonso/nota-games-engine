# Motion Scoring Architecture (V1)

## Design Principles

- Score effort, not movements.
- Reward sustained activity, not spikes.
- Exercise agnostic.
- Prevent huge score jumps from isolated movements.
- Ensure predictable score growth.
- Phone only streams sensor data.
- Engine owns all scoring logic.
- Controller only displays scores.

---

# 1. Phone / Sensor

## Responsibility

Capture motion data and stream it to the engine.

## Input

Accelerometer data:

- `x`
- `y`
- `z`
- `timestamp`

## Behaviour

### During WORK phase

- Start sampling sensors.
- Stream motion packets continuously.

### During REST phase

- Stop sending motion data.

## Phone does NOT

- Calculate scores.
- Know exercise types.
- Know scoring thresholds.
- Know player rankings.

The phone is purely a sensor.

---

# 2. Engine

The engine owns all scoring.

## Step A: Receive Motion Stream

For each player, receive:

- `timestamp`
- `x`
- `y`
- `z`

Maintain an independent scoring pipeline per player.

---

## Step B: Calculate Motion Energy

Convert raw XYZ movement into a single effort signal.

Think:

> "How much movement happened?"

Not:

> "What exercise was performed?"

### Output

Motion Energy

A continuous numeric value representing effort.

---

## Step C: Aggregate Into Windows

Do not score every sensor sample.

Accumulate movement inside fixed windows.

### Recommended

5-second windows.

| Window | Time |
|----------|------|
| Window 1 | 0-5 sec |
| Window 2 | 5-10 sec |
| Window 3 | 10-15 sec |
| ... | ... |

A 45-second work interval produces 9 scoring windows.

---

## Step D: Smooth Out Spikes

A single violent shake should not dominate scoring.

Possible techniques:

- Moving average
- RMS
- Low-pass filtering

### Purpose

Measure sustained effort, not instantaneous peaks.

---

## Step E: Clamp Maximum Effort

Prevent outliers.

Movement should saturate at a maximum scoring rate.

```text
Low effort
    ↓
Medium effort
    ↓
High effort
    ↓
Maximum score rate
