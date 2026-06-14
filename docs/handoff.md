# NOTA Games — Backend Handoff

## Overview

The backend is a Node.js/TypeScript server backed by Supabase (Postgres + Realtime). There are two client surfaces:

- **Mobile app** — player-facing. Authenticates, joins a session, sends motion data in the background, receives score updates.
- **Web app** — two views:
  - **Game controller** — instructor-facing. Creates sessions, assigns players, drives session state.
  - **Scoreboard** — display-only. Subscribes to live leaderboard updates.

All communication is either REST (setup/control) or Supabase Realtime (live data during a session). The user interacts with the mobile app twice: once to join, once to see final results. Everything else happens in the background.

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

All API requests require a Supabase Auth JWT in the Authorization header:

```
Authorization: Bearer <supabase_access_token>
```

Obtain the token by signing in via the Supabase client:

```ts
const { data } = await supabase.auth.signInWithPassword({ email, password });
const jwt = data.session.access_token;
```

---

## Mobile app

### Lifecycle

```
App open
└── Sign in → get JWT
└── Join session (one tap)
└── [background] subscribe to session:state events
    ├── status = active     → start sending motion batches every 5s
    ├── status = paused     → pause sending
    ├── status = pass_break → pause sending (wait for active)
    └── status = ended      → stop sending → call /leave → show results
```

The user interacts with the app only at join and results. Everything else is background.

### Endpoints

#### POST /sessions/:id/join

Call once when the player enters a session. Returns their team/duo assignment. This is the trigger to start Realtime subscriptions.

Headers: Authorization: Bearer \<jwt\>

Response 200:
```json
{
  "sessionId":  "uuid",
  "playerId":   "uuid",
  "playerName": "string",
  "teamId":     "uuid | null",
  "duoId":      "uuid | null"
}
```

Errors:
- 401 — not authenticated
- 403 — not registered for this session (instructor must add them first)

---

#### POST /sessions/:id/motion

Send a batch of raw accelerometer samples every 5 seconds while the session phase is "work". Pause during any other phase. Resume when "active" is received on the state channel.

Headers: Authorization: Bearer \<jwt\>
Content-Type: application/json

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
- sampleRateHz: device sample rate, e.g. 20 for a 50ms tick interval
- samples: raw linear acceleration with gravity removed (m/s²), minimum 1 sample
- x/y/z: user accelerometer values, not raw accelerometer

Response 202:
```json
{ "received": true, "batchStartedAt": 1700000000000 }
```

Errors:
- 400 — invalid payload, includes field-level issues array
- 401 — not authenticated
- 403 — not joined to this session, call /join first
- 502 — Realtime publish failed, retry the batch

---

#### DELETE /sessions/:id/leave

Call when the session ends or the player exits the app. Untracks presence and logs a player_left event.

Headers: Authorization: Bearer \<jwt\>

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
    if (payload.status === 'active')     startSendingMotion();
    if (payload.status === 'paused')     pauseSendingMotion();
    if (payload.status === 'pass_break') pauseSendingMotion();
    if (payload.status === 'ended')      stopAndLeave();
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
  sessionId: string;
  status:    'active' | 'paused' | 'pass_break' | 'ended';
  timestamp: number;
}
```

---

## Web app — Game controller

### Session lifecycle

```
Create session
└── Add participants (with team/duo assignments)
└── Start → PATCH state: active
    ├── Pause  → PATCH state: paused
    ├── Resume → PATCH state: active
    └── End    → PATCH state: ended
```

### Endpoints

#### POST /dashboard/sessions

Create a new session before the class starts.

Headers: Authorization: Bearer \<jwt\>

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

teamFormat values: "solo" | "team" | "mixed"

Response 201: Full session object including id — store this as sessionId.

---

#### POST /dashboard/sessions/:id/participants

Add a player to the session. Call once per player before starting. Must be called before PATCH state: active — RLS blocks new participants after that.

Body:
```json
{
  "playerId":   "uuid",
  "playerName": "string",
  "teamId":     "uuid (omit if solo)",
  "duoId":      "uuid (omit if not in a duo)"
}
```

Response 201: Participant row.
Errors:
- 404 — session not found
- 409 — session already started, or player already registered

---

#### GET /dashboard/sessions/:id/participants

List all registered participants with team and duo names.

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
      "teams":       { "name": "Team Red", "color": "#FF0000" },
      "duos":        { "name": "Duo A" }
    }
  ]
}
```

---

#### PATCH /dashboard/sessions/:id/state

Transition the session. Broadcasts session_state_change to all connected clients immediately.

Body:
```json
{ "status": "active" }
```

Transition reference:
- Start session:           `{ "status": "active" }`
- Pause:                   `{ "status": "paused" }`
- Resume after pause:      `{ "status": "active" }`
- Resume after pass break: `{ "status": "active" }`
- End session:             `{ "status": "ended" }`

Response 200:
```json
{
  "id":        "uuid",
  "status":    "active",
  "startedAt": "ISO timestamp | null",
  "endedAt":   "ISO timestamp | null"
}
```

---

#### GET /dashboard/sessions/:id

Fetch full session details including current phase and pass.

Response 200: Full session object.

---

#### GET /dashboard/sessions/:id/leaderboard

Fetch the current leaderboard. Add ?pass=N for per-pass rankings. Omit for overall.

Response 200:
```json
{
  "sessionId": "uuid",
  "pass":      null,
  "updatedAt": 1700000000000,
  "entries": [
    {
      "rank":            1,
      "playerId":        "uuid",
      "playerName":      "string",
      "teamId":          "uuid | null",
      "teamName":        "string | null",
      "duoId":           "uuid | null",
      "duoName":         "string | null",
      "totalXp":         342.5,
      "overallRank":     1,
      "duoTotalXp":      610.2,
      "duoRank":         1,
      "passXp":          0,
      "currentPassRank": null
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
    updateControllerUI(payload.status);
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
renderLeaderboard(data.entries);
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
| session:{id}:motion | Mobile app | Game Engine | motion_batch |
| session:{id}:scores | Game Engine | Mobile + Scoreboard | leaderboard_update, presence_update |
| session:{id}:state | Game controller | Mobile + Scoreboard | session_state_change |

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

Validation errors (400) include an issues array:
```json
{
  "error": "Invalid request body",
  "issues": [
    { "path": "samples.0.x", "message": "Expected number, received string" }
  ]
}
```
