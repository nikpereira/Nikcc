# WebRTC Call Center v2

Full-featured browser-based call center with voice, chat, file sharing, screen share, authentication, Turso database, and supervisor dashboard.

## URLs

| URL | Who |
|---|---|
| `/` | Customer page (call or chat) |
| `/agent` | Agent dashboard (login required) |
| `/supervisor` | Supervisor dashboard (login required) |

## Setup

### 1. Get Turso database (free)

```bash
# Install Turso CLI
curl -sSfL https://get.tur.so/install.sh | bash

# Login / signup
turso auth login

# Create database
turso db create callcenter

# Get URL and token
turso db show callcenter --url
turso db tokens create callcenter
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your Turso URL and token
```

### 3. Run locally

```bash
npm install
node server.js
```

### 4. Deploy to Render

Push to GitHub, connect repo to Render as a Web Service.
Set environment variables in Render dashboard:
- `TURSO_URL` — your Turso database URL
- `TURSO_TOKEN` — your Turso auth token
- `JWT_SECRET` — any long random string

## Default credentials

| Role | Email | Password |
|---|---|---|
| Supervisor | supervisor@callcenter.com | supervisor123 |

Change the password after first login via the Agents page → create a new supervisor, or update the DB directly.

## Features

### Customer
- Voice call or live chat
- File sharing in chat
- Screen share during call
- Hold indicator
- Mute / speaker controls
- Call quality indicator
- Post-call star rating

### Agent
- JWT login (email + password)
- Voice call: mute, hold, speaker, screen share, record
- Transfer to available agent
- Escalate to supervisor
- Live chat with file sharing
- Call notes (saved to DB)
- Disposition tagging
- Call history (persistent, per agent)
- Daily stats + 7-day trend chart
- Keyboard shortcuts (M/H/E/A)

### Supervisor
- Real-time live call monitor
- Live queue view with wait times
- Agent status board
- Escalation inbox — accept escalated calls
- Agent management (add/remove)
- Reports: 30-day call volume, ratings, disposition breakdown, agent performance
- Charts powered by Chart.js

## Architecture

```
Browser (Customer/Agent/Supervisor)
         |  WebSocket (Socket.IO) + WebRTC
         v
Node.js Server (Express + Socket.IO)
         |
         ├── REST API (/api/*)
         ├── WebRTC signaling relay
         └── Turso (cloud SQLite)
```
