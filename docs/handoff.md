# NOTA Games — Backend Handoff

## Overview

The backend is a Node.js/TypeScript server backed by Supabase (Postgres + Realtime). There are two client surfaces:

- **Mobile app** — player-facing. No authentication required. Players self-register onto a session with their name, send motion data in the background, and receive score updates via Realtime.
- **Web app** — two views:
  - **Game controller** — instructor-facing. Requires authentication. Creates sessions, manages teams, drives session state.
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
└── [background] subscribe to session:state and session:scores channels
└── On session_state_change:
    ├── state.isRunning = true  → start sending motion batches every 5s
    ├── state.isPaused  = true  → pause sending
    ├── state.phase = 'complete' → stop sending → call /leave → show results
```

**Important:** The `playerId` returned by `/join` must be stored persistently on the device (local storage / keychain). It is required for all subsequent calls (`/motion`, `/leave`) and enables re-joining the same session after a disconnect without losing score history.

### Endpoints

#### POST /sessions/:id/join

Self-registers the player onto the session and returns their identity. Call once on first join. Call again with the same `playerId` to re-join after a disconnect.

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
  "teamId":     "uuid | null",
  "duoId":      "uuid | null",
  "isRejoin":   false
}
```

Field notes:
- `playerId` — persist this immediately. Send it in all subsequent requests.
- `isRejoin` — true if the player was already registered (reconnect scenario). No duplicate event is logged.
- `teamId` / `duoId` — null until the instructor runs team assignment from the controller.

Errors:
- 400 — missing or invalid `playerName`
- 403 — session has already ended
- 404 — session not found

---

#### POST /sessions/:id/motion

Send a batch of raw accelerometer samples every 5 seconds while `state.isRunning` is true. Pause when `state.isPaused` is true or `state.phase` is not `'work'`.

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
- 502 — Realtime publish failed, retry the batch

---

#### DELETE /sessions/:id/leave

Call when the session ends or the player exits the app. Untracks presence and logs a `player_left` event.

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
    if (payload.state.isRunning)              startSendingMotion();
    if (payload.state.isPaused)               pauseSendingMotion();
    if (payload.state.phase === 'complete')   stopAndLeave();
  })
  .subscribe();

// On leave:
await supabase.removeChannel(scoresChannel);
await supabase.removeChannel(stateChannel);
```

### Realtime payload types

```ts
// leaderboard_update — emitted after every scored motion batch
interface LeaderboardUpdate {
  sessionId:   string;
  updatedAt:   number;
  leaderboard: {
    playerId:   string;
    playerName: string;
    total_xp:   number;
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
    duoId:      string | null;
    joinedAt:   number;
  }[];
}

// session_state_change — drives all mobile background behaviour
interface SessionStateChange {
  timestamp: number;
  state: {
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
Create session
└── Players self-register via POST /sessions/:id/join (no action needed from instructor)
└── [optional] Manually add or override a participant
    └── POST /dashboard/sessions/:id/participants
└── Assign teams
    ├── Auto:          POST  /dashboard/sessions/:id/participants/assign
    ├── Manual (bulk): PATCH /dashboard/sessions/:id/participants
    └── Manual (one):  PATCH /dashboard/sessions/:id/participants/:participantId
└── Start → PATCH state: active
    ├── Pause  → PATCH state: paused
    ├── Resume → PATCH state: active
    └── End    → PATCH state: ended
```

### Endpoints

All dashboard endpoints require: `Authorization: Bearer <jwt>`

---

#### POST /dashboard/sessions

Create a new session before the class starts.

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

Manually pre-registers a player. Use this to override a player's name or pre-assign a specific team/duo before the session starts. Players can also self-register via `POST /sessions/:id/join` — this endpoint is not required for normal flow.

Body:
```json
{
  "playerId":   "uuid",
  "playerName": "string",
  "teamId":     "uuid (optional)",
  "duoId":      "uuid (optional)"
}
```

Response 201: Participant row.

Errors:
- 404 — session not found
- 409 — session already started, or player already registered

---

#### GET /dashboard/sessions/:id/participants

List all registered participants with their resolved team and duo names.

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
      "duo_id":      "uuid | null",
      "joined_at":   "ISO timestamp",
      "teams":       { "name": "Team Red" },
      "duos":        { "name": "Duo A" }
    }
  ]
}
```

---

#### POST /dashboard/sessions/:id/participants/assign

Auto-assigns all unassigned participants to the session's teams using round-robin distribution (fills the smallest team first). The session must have at least one team before calling this.

No body required.

Response 200:
```json
{ "assigned": 4 }
```

Errors:
- 409 — no teams exist for this session

---

#### PATCH /dashboard/sessions/:id/participants

Bulk manual assignment — assign multiple participants to teams in a single request. Participants sharing the same `teamId + duoId` combination are applied in one DB write. Setting `teamId` to `null` clears both team and duo for that participant.

Body:
```json
{
  "assignments": [
    { "participantId": "uuid", "teamId": "uuid", "duoId": "uuid" },
    { "participantId": "uuid", "teamId": "uuid", "duoId": "uuid" },
    { "participantId": "uuid", "teamId": "uuid" },
    { "participantId": "uuid", "teamId": null }
  ]
}
```

Response 200:
```json
{
  "assigned": 4,
  "participants": [
    { "id": "uuid", "playerId": "uuid", "playerName": "string", "teamId": "uuid | null", "duoId": "uuid | null" }
  ]
}
```

Errors:
- 400 — any entry has `duoId` without `teamId`, or `assignments` is empty
- 500 — DB update failed (operation is all-or-nothing)

---

#### PATCH /dashboard/sessions/:id/participants/:participantId

Manually assigns a single participant to a specific team (and optionally a duo). Set `teamId` to `null` to remove the team assignment — this also clears any `duoId`.

Body:
```json
{
  "teamId": "uuid | null",
  "duoId":  "uuid | null (optional, requires teamId)"
}
```

Response 200:
```json
{
  "id":         "uuid",
  "playerId":   "uuid",
  "playerName": "string",
  "teamId":     "uuid | null",
  "duoId":      "uuid | null"
}
```

Errors:
- 400 — `duoId` provided without `teamId`
- 404 — participant not found in this session

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

Response 200:
```json
{
  "updated":   true,
  "gameState": { "timestamp": 1700000000000, "state": { ... } }
}
```

`gameState` is `null` when no `phase` was included in the request.

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
      "duo_id":          "uuid | null",
      "total_xp":        342.5,
      "overall_rank":    1,
      "duo_total_xp":    610.2,
      "duo_rank":        1,
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
| `session:{id}:motion` | Mobile app | Game Engine | `motion_batch` |
| `session:{id}:scores` | Game Engine | Mobile + Scoreboard + Controller | `leaderboard_update`, `presence_update` |
| `session:{id}:state` | Game controller | Mobile + Scoreboard + Game Engine | `session_state_change` |
| `session:{id}:presence` | Game Engine (internal) | Game Engine only | Supabase Presence sync |

> **Note:** Clients do not subscribe to `session:{id}:presence` directly.
> The server uses it internally to track connected players via Supabase Presence.
> Presence state is forwarded to `session:{id}:scores` as `presence_update` events,
> which is the only channel clients need to subscribe to for both scores and presence.

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
