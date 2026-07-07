# NOTA Games — Backend Handoff

## Overview

The backend is a Node.js/TypeScript server backed by Supabase (Postgres + Realtime). There are two client surfaces:

- **Mobile app** — player-facing. No authentication required. Players self-register onto a session with their name, send motion data in the background, and receive score updates via Realtime.
- **Web app** — two views:
  - **Game controller** — instructor-facing. Requires authentication. Creates sessions, drives session state.
  - **Scoreboard** — display-only. Subscribes to live leaderboard updates.

All communication is either REST (setup/control) or Supabase Realtime (live data during a session).

---

## Environment setup

Both clients need the following values (provided separately — do not commit):

| Variable | Used by | Where to find |
|---|---|---|
| `SUPABASE_URL` | Mobile + Web | Supabase Dashboard → Settings → API |
| `SUPABASE_ANON_KEY` | Mobile + Web | Supabase Dashboard → Settings → API → anon public |
| `SERVER_URL` | Mobile + Web | Base URL of the running backend server |

---

## Authentication

**Player routes** (`/sessions/...`) — no authentication required.

**Dashboard routes** (`/dashboard/sessions/...`) — all require a Supabase Auth JWT in the `Authorization` header:

```
Authorization: Bearer <access_token>
```

Obtain the token via the login endpoint:

#### POST /auth/login

```json
{ "email": "instructor@example.com", "password": "yourpassword" }
```

Response 200:
```json
{
  "accessToken": "eyJ...",
  "expiresAt":   1700003600,
  "user": { "id": "uuid", "email": "instructor@example.com" }
}
```

Use `accessToken` as the `Bearer` token on all `/dashboard/sessions/...` requests.

Errors:
- 400 — missing or invalid email/password fields
- 401 — wrong credentials

---

## Mobile app

### Lifecycle

```
App open
└── Join session with name (one tap)
    └── Persist returned playerId to local storage
    └── Server auto-assigns player to Red or Blue team
    └── If gameState.state.sensorActive = true → start sending motion batches immediately
└── [background] subscribe to session:state and session:scores channels
└── On session_state_change:
    ├── state.sensorActive = true  → start (or continue) sending motion batches every 5s
    ├── state.sensorActive = false → stop sending
    └── state.sessionEnded = true  → stop sending → call /leave → show results
```

**Important:** The `playerId` returned by `/join` must be stored persistently on the device (local storage / keychain). It is required for all subsequent calls (`/motion`, `/leave`) and enables re-joining the same session after a disconnect without losing score history.

### Endpoints

#### POST /sessions/:id/join

Self-registers the player onto the session and auto-assigns them to the smaller of the two teams (Red or Blue). Call once on first join. Call again with the same `playerId` to re-join after a disconnect — existing team assignment is preserved.

No authentication required.

Body:
```json
{
  "playerName": "string",
  "playerId":   "uuid (omit on first join — server generates one)"
}
```

Response 200:
```json
{
  "sessionId":  "uuid",
  "playerId":   "uuid",
  "playerName": "string",
  "team": {
    "id":    "uuid",
    "name":  "Red",
    "color": "#EF4444"
  },
  "isRejoin":   false,
  "gameState":  null
}
```

Field notes:
- `playerId` — persist this immediately. Send it in all subsequent requests.
- `team` — assigned immediately on first join via auto-assignment. `null` only if the session has no teams configured. `color` is a hex string (e.g. `#EF4444` for Red, `#3B82F6` for Blue) — use directly for UI tinting.
- `isRejoin` — true if the player was already registered (reconnect scenario). No duplicate event is logged.
- `gameState` — the current `SessionStateChange` payload if the session is already running, or `null` if it hasn't started yet. **Check this immediately after joining.** If `gameState.state.sensorActive` is true, start sending motion batches right away — do not wait for the first `session_state_change` broadcast.

Errors:
- 400 — missing or invalid `playerName`
- 403 — session has already ended
- 404 — session not found

---

#### POST /sessions/:id/motion

Send a batch of raw accelerometer samples every 5 seconds while `state.sensorActive` is true. Stop when `state.sensorActive` becomes false.

No authentication required.

Body:
```json
{
  "playerId":       "uuid",
  "playerName":     "string",
  "batchStartedAt": 1700000000000,
  "batchEndedAt":   1700000005000,
  "sampleRateHz":   20,
  "samples": [
    { "timestamp": 1700000000050, "x": 1.2, "y": -0.4, "z": 9.8 }
  ]
}
```

Field notes:
- `sampleRateHz` — device sample rate, e.g. 20 for a 50ms tick interval
- `samples` — raw linear acceleration with gravity removed (m/s²), minimum 1 sample
- `x/y/z` — user accelerometer values, not raw accelerometer

Response 202:
```json
{ "received": true, "batchStartedAt": 1700000000000 }
```

Errors:
- 400 — invalid payload, includes field-level `issues` array
- 403 — not joined to this session, call /join first

---

#### DELETE /sessions/:id/leave

Call when the session ends or the player exits the app. Logs a `player_left` event and removes the player from the server's in-memory session. Call `presenceChannel.untrack()` client-side before this endpoint so the presence channel is cleaned up first.

No authentication required.

Body:
```json
{ "playerId": "uuid" }
```

Response 200:
```json
{ "left": true }
```

---

### Realtime subscriptions

```ts
// Scores and presence — subscribe after /join
const scoresChannel = supabase
  .channel(`session:${sessionId}:scores`)
  .on('broadcast', { event: 'leaderboard_update' }, ({ payload }) => {
    updateLeaderboard(payload);
  })
  .on('broadcast', { event: 'presence_update' }, ({ payload }) => {
    updateConnectedPlayers(payload);
  })
  .subscribe();

// State — drives all background behaviour
const stateChannel = supabase
  .channel(`session:${sessionId}:state`)
  .on('broadcast', { event: 'session_state_change' }, ({ payload }) => {
    if (payload.state.sensorActive) startSendingMotion();
    else                            stopSendingMotion();
    if (payload.state.sessionEnded) stopAndLeave();
  })
  .subscribe();

// Presence — track yourself after /join so the controller sees you as connected.
// Supabase automatically removes your entry when your WebSocket drops, which
// triggers an immediate presence_update broadcast to the controller.
const presenceChannel = supabase
  .channel(`session:${sessionId}:presence`)
  .subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await presenceChannel.track({
        playerId,
        playerName,
        teamId:    team?.id    ?? null,
        teamName:  team?.name  ?? null,
        teamColor: team?.color ?? null,
        joinedAt:  Date.now(),
      });
    }
  });

// On leave (call before /leave endpoint):
await presenceChannel.untrack();
await supabase.removeChannel(presenceChannel);
await supabase.removeChannel(scoresChannel);
await supabase.removeChannel(stateChannel);
```

### Realtime payload types

```ts
// leaderboard_update — emitted after every scored motion batch
// All XP values are normalized: the leading team is always scaled to exactly 1000
// when its raw total exceeds 1000. All other teams scale proportionally.
// Raw (un-normalized) totals are stored in the database and available via
// GET /dashboard/sessions/:id/leaderboard.
interface LeaderboardUpdate {
  sessionId: string;
  updatedAt: number;
  teams: {
    teamId:  string;
    name:    string;   // e.g. "Red", "Blue"
    color:   string;   // hex color, e.g. "#EF4444"
    totalXp: number;   // normalized team total (≤ 1000)
  }[];
  leaderboard: {
    playerId:   string;
    playerName: string;
    teamId:     string | null;
    total_xp:   number;   // normalized individual XP
    rank:       number;
  }[];
}

// presence_update — emitted when a player joins or leaves
interface PresenceUpdate {
  sessionId: string;
  updatedAt: number;
  connectedPlayers: {
    playerId:   string;
    playerName: string;
    teamId:     string | null;
    joinedAt:   number;
  }[];
}

// session_state_change — drives all mobile background behaviour
interface SessionStateChange {
  timestamp: number;
  state: {
    // Binary sensor signals — sensor client only needs these two fields
    sensorActive: boolean; // true = send motion batches; false = stop
    sessionEnded: boolean; // true = call /leave and show results

    // Full game state — used by controller UI and scoreboard
    phase:              'work' | 'rest' | 'passBreak' | 'complete';
    currentStation:     number;
    currentRound:       number;
    currentPass:        number;
    timeRemaining:      number;
    isRunning:          boolean;
    isPaused:           boolean;
    completedIntervals: number;
    totalIntervals:     number;
  };
}
```

---

## Web app — Game controller

### Session lifecycle

```
Create session  (auto-creates Red and Blue teams)
└── Players self-register and are auto-assigned to a team via POST /sessions/:id/join
└── [optional] Manually pre-register a participant
    └── POST /dashboard/sessions/:id/participants
└── Start → PATCH state: active
    ├── Pause  → PATCH state: paused
    ├── Resume → PATCH state: active
    └── End    → PATCH state: ended
```

### Endpoints

All dashboard endpoints require: `Authorization: Bearer <jwt>`

---

#### POST /dashboard/sessions

Create a new session. Automatically creates **Red** (`#EF4444`) and **Blue** (`#3B82F6`) teams for the session — no additional setup required before players join.

Body:
```json
{
  "title":      "Monday HIIT",
  "teamFormat": "team",
  "config": {
    "stations":          6,
    "roundsPerStation":  3,
    "fullSessionPasses": 2,
    "workDurationSecs":  40,
    "restDurationSecs":  20
  }
}
```

`teamFormat` values: `"solo"` | `"team"` | `"mixed"`

Response 201: Full session object including `id` — store this as `sessionId`.

---

#### POST /dashboard/sessions/:id/participants

Manually pre-registers a player before they join. Team assignment happens automatically when the player calls `/join` — not here.

Body:
```json
{
  "playerId":   "uuid",
  "playerName": "string"
}
```

Response 201: Participant row.

Errors:
- 404 — session not found
- 409 — session already started, or player already registered

---

#### GET /dashboard/sessions/:id/participants

List all registered participants with their resolved team name.

Response 200:
```json
{
  "sessionId": "uuid",
  "participants": [
    {
      "id":          "uuid",
      "player_id":   "uuid",
      "player_name": "string",
      "team_id":     "uuid | null",
      "joined_at":   "ISO timestamp",
      "teams":       { "name": "Red", "color": "#EF4444" }
    }
  ]
}
```

---

#### PATCH /dashboard/sessions/:id/state

Transitions the session state and broadcasts `session_state_change` to all connected clients. Send `phase` to trigger a full game state broadcast (required for players to start/stop motion). Send `status` alone for simple start/end transitions.

Body:
```json
{
  "status":           "active | paused | ended (optional)",
  "phase":            "work | rest | passBreak | complete (optional)",
  "currentStation":   1,
  "currentRound":     1,
  "currentPass":      1,
  "timeRemaining":    40,
  "isRunning":        true,
  "isPaused":         false,
  "completedIntervals": 0,
  "totalIntervals":   18
}
```

Transition reference:
- Start session:           `{ "status": "active" }`
- Begin work interval:     `{ "status": "active", "phase": "work", "isRunning": true, ... }`
- Pause mid-interval:      `{ "status": "paused", "phase": "work", "isPaused": true, ... }`
- Resume after pause:      `{ "status": "active", "phase": "work", "isRunning": true, ... }`
- End session:             `{ "status": "ended" }`

> **On end:** The server automatically broadcasts `session_state_change` with `phase: "complete"` and `isRunning: false` to all connected clients, even if `phase` is omitted from the request. Clients always receive a disconnect signal. After the broadcast, the server tears down all Realtime channels for the session and clears the in-memory registry — subsequent motion batches from any player are rejected with 403.

Response 200:
```json
{
  "updated":   true,
  "gameState": { "timestamp": 1700000000000, "state": { ... } }
}
```

`gameState` is `null` only for non-end status-only transitions (e.g. `{ "status": "active" }` at session start). When `status: "ended"` is sent without a `phase`, the server synthesises `phase: "complete"` — `gameState` will be non-null with `sessionEnded: true`.

---

#### GET /dashboard/sessions/:id/leaderboard

Fetch the current leaderboard. Add `?pass=N` for per-pass rankings. Omit for overall.

Response 200:
```json
{
  "sessionId": "uuid",
  "pass":      null,
  "leaderboard": [
    {
      "rank":            1,
      "player_id":       "uuid",
      "player_name":     "string",
      "team_id":         "uuid | null",
      "total_xp":        342.5,
      "overall_rank":    1,
      "pass_xp":         0,
      "current_pass_rank": null
    }
  ]
}
```

---

### Realtime subscription (game controller)

```ts
const stateChannel = supabase
  .channel(`session:${sessionId}:state`)
  .on('broadcast', { event: 'session_state_change' }, ({ payload }) => {
    if (payload.state.sensorActive) startSendingMotion();
    else                            stopSendingMotion();
    if (payload.state.sessionEnded) leaveSession();

    updateControllerUI(payload.state);
  })
  .subscribe();
```

---

## Web app — Scoreboard

Display-only. No API calls needed during a session — subscribe to Realtime on load and fetch the initial leaderboard once.

### Initial load

```ts
const res  = await fetch(`${SERVER_URL}/dashboard/sessions/${sessionId}/leaderboard`, {
  headers: { Authorization: `Bearer ${jwt}` },
});
const data = await res.json();
renderLeaderboard(data.leaderboard);
```

### Live updates

```ts
const scoresChannel = supabase
  .channel(`session:${sessionId}:scores`)
  .on('broadcast', { event: 'leaderboard_update' }, ({ payload }) => {
    renderLeaderboard(payload.leaderboard);
  })
  .on('broadcast', { event: 'presence_update' }, ({ payload }) => {
    renderConnectedPlayers(payload.connectedPlayers);
  })
  .subscribe();
```

The leaderboard updates automatically after every motion batch (~5 seconds per active player).

---

## Realtime channel reference

| Channel | Publisher | Subscribers | Events |
|---|---|---|---|
| `session:{id}:scores` | Game Engine (via REST broadcast) | Mobile + Scoreboard + Controller | `leaderboard_update`, `presence_update` |
| `session:{id}:state` | Game controller (via REST broadcast) | Mobile + Scoreboard + Game Engine | `session_state_change` |
| `session:{id}:presence` | Mobile app (each device tracks itself) | Game Engine (listener) | Supabase Presence sync/join/leave |

> **Motion batches are not sent over Realtime.** The mobile app posts batches directly to `POST /sessions/:id/motion` (HTTP). The server scores each batch synchronously and broadcasts the updated leaderboard to `session:{id}:scores`. There is no `session:{id}:motion` Realtime channel.

---

## Scoring

Each motion batch is run through a fixed pipeline on the server. No client-side scoring happens.

```
Raw accelerometer samples (x, y, z)
  → Vector magnitude per sample: √(x² + y² + z²)
  → Low-pass IIR filter (α = 0.3): removes jitter, preserves 0–3 Hz movement signal
  → RMS over the 5-second window: measures sustained effort energy
  → Moving average over last 4 windows (20 s): scores build and fall naturally
  → XP = min(smoothedRms × 10, 30)   ← per window ceiling: 30 XP
```

At full sustained effort a player earns ~30 XP per 5-second window, topping out at roughly 360 XP over a 2-minute pass.

**Normalization** — before broadcasting, team totals are computed and checked against a 1000 XP ceiling. If any team exceeds 1000, all individual and team XP values are scaled down proportionally so the leading team shows exactly 1000. Scores stored in the database are always raw (un-normalized).

**Pausing** — when `state.isPaused` is true the server accepts motion batches but awards 0 XP and does not advance the moving-average window. Scores resume from the same level when the session is unpaused.

---

## Health check

```
GET /health
Response: { "ok": true, "ts": 1700000000000 }
```

Use this to confirm the server is reachable before starting a session.

---

## Error format

All errors:
```json
{
  "error":  "Human-readable message",
  "detail": "Optional — raw error for debugging"
}
```

Validation errors (400) include an `issues` array:
```json
{
  "error": "Invalid request body",
  "issues": [
    { "path": "samples.0.x", "message": "Expected number, received string" }
  ]
}
```
