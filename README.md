# Choopi Finance

A locally-hosted, LAN-accessible personal finance tracker.

## Stack

| Layer     | Tech                                              |
|-----------|---------------------------------------------------|
| Frontend  | React 18 · Vite · TypeScript · Tailwind v4        |
| Backend   | Node.js · Express · TypeScript                    |
| Database  | SQLite (better-sqlite3)                           |
| Auth      | JWT in httpOnly cookie                            |
| Data sync | TanStack React Query                              |
| Icons     | Lucide React                                      |
| Fonts     | IBM Plex Sans · IBM Plex Mono · IBM Plex Serif (local) |

---

## Getting started

### Prerequisites

- Node.js 20+
- npm 10+

### Install & run

```bash
cd choopi-finance
npm install

# one-time: create the server env file with a real JWT secret
cp server/.env.example server/.env
sed -i '' "s/replace-with-a-long-random-secret/$(openssl rand -hex 32)/" server/.env
npm run dev
```

This starts both processes concurrently:

| Process | URL                        |
|---------|----------------------------|
| Client  | http://localhost:5173       |
| Server  | http://localhost:3001       |
| Health  | http://localhost:3001/api/health |

The "Hello Choopi" smoke-test page confirms IBM Plex Serif italic, the brand gradient, and all design tokens are wired correctly.

---

## Accessing from another device on your LAN (phone, tablet, etc.)

### 1. Find your machine's LAN IP

**macOS:**
```bash
ipconfig getifaddr en0
# or for Wi-Fi:
ipconfig getifaddr en1
```

**Linux:**
```bash
ip addr show | grep "inet " | grep -v 127
```

**Windows (PowerShell):**
```powershell
(Get-NetIPAddress -AddressFamily IPv4 | Where InterfaceAlias -ne Loopback).IPAddress
```

You'll get something like `192.168.1.42`.

### 2. Open in any browser on your network

```
http://192.168.1.42:5173
```

Both the Vite dev server (`server.host = "0.0.0.0"`) and the Express server are already bound to all interfaces — no extra configuration needed.

> **Note:** This is a private LAN app. Anyone on your home network can reach it. Keep that in mind before enabling open registration.

---

## Project structure

```
choopi-finance/
├── client/               # Vite + React app
│   ├── public/
│   │   └── fonts/        # (optional) raw font files — see below
│   └── src/
│       ├── components/   # Shared UI primitives
│       ├── pages/        # Route components
│       ├── hooks/        # React Query hooks
│       ├── lib/          # fmt(), api client, FX helpers
│       └── styles/
│           ├── tokens.css    # Design tokens (CSS custom properties)
│           └── index.css     # Tailwind v4 + @theme mapping
├── server/
│   ├── data/             # SQLite file lives here (gitignored)
│   └── src/
│       ├── routes/       # auth, investments, transactions, prices, fx, csv
│       ├── db/           # schema.sql, init.ts
│       ├── services/     # fifo, fx, prices, csv
│       ├── middleware/   # auth, errorHandler
│       └── index.ts
├── shared/
│   └── types.ts          # Shared TypeScript types
└── README.md
```

---

## Fonts

Fonts are bundled locally via `@fontsource` npm packages — no CDN required.
They are imported at the top of `client/src/styles/index.css` and processed by Vite.

The app uses the **IBM Plex** superfamily for a cohesive, professional finance look. All numeric output uses tabular figures (`font-variant-numeric: tabular-nums`) so digits stay column-aligned.

| Font            | Package                                   | Role                        |
|-----------------|-------------------------------------------|-----------------------------|
| IBM Plex Sans   | `@fontsource-variable/ibm-plex-sans`      | UI, body, headings (variable) |
| IBM Plex Mono   | `@fontsource/ibm-plex-mono`               | All numeric output (tabular) |
| IBM Plex Serif  | `@fontsource/ibm-plex-serif`              | Display / wordmark only (italic) |

Because these ship as npm packages, `npm install` is all you need — no manual downloading or CDN calls happen at runtime. The app works fully offline.

---

## Design tokens

All semantic colors live as CSS custom properties on `[data-theme="light"]` / `[data-theme="dark"]`.
Switching themes is one attribute change on `<html>`:

```ts
document.documentElement.setAttribute("data-theme", "dark");
```

Tailwind utilities read these vars at runtime via `@theme inline { ... }` in `index.css`.

Key tokens:

| Token           | Light       | Dark        | Usage                        |
|-----------------|-------------|-------------|------------------------------|
| `--bg`          | `#F7F5F0`   | `#0B0B0F`   | Page background              |
| `--surface`     | `#FFFFFF`   | `#15161B`   | Cards, modals                |
| `--text`        | `#18181B`   | `#F4F4F5`   | Primary text                 |
| `--grad-from`   | `#7C3AED`   | same        | Brand gradient start (violet) |
| `--grad-to`     | `#F472B6`   | same        | Brand gradient end (pink)    |
| `--emerald`     | `#0F9D6E`   | same        | Gains, BUY, positive         |
| `--rose`        | `#E5484D`   | same        | Losses, SELL, destructive    |

---

## Environment variables

Create `server/.env` for local overrides (not committed):

```env
PORT=3001
JWT_SECRET=change-me-in-production
JWT_EXPIRES_IN=7d
```

---

## Scripts

| Command             | Description                                                 |
|---------------------|-------------------------------------------------------------|
| `npm run dev`       | Start client (`:5173`) + server (`:3001`) in watch mode     |
| `npm run build`     | Build both client and server                                |
| `npm run start`     | Build everything then serve on `:3001` (LAN production mode)|
| `npm run dev -w client` | Client only                                             |
| `npm run dev -w server` | Server only                                             |

### LAN production mode (`npm run start`)

`npm run start` builds the client into `client/dist` and the server into `server/dist`,
then starts the Express server on port **3001**. The server also serves the compiled React
app from the same port, so a single URL covers everything:

```
http://<your-LAN-ip>:3001
```

**Steps:**

1. Run `npm run start` on the host machine.
2. Find your LAN IP:
   - macOS: `ipconfig getifaddr en0` (Ethernet) or `en1` (Wi-Fi)
   - Linux: `ip addr show | grep "inet " | grep -v 127`
   - Windows: `ipconfig` → IPv4 under the Wi-Fi adapter
3. Open `http://192.168.x.x:3001` in any browser on the same network.
4. On iOS/Android: use **"Add to Home Screen"** for an app-like experience.

**Keep it running with pm2:**

```bash
npm install -g pm2
pm2 start "npm run start" --name choopi
pm2 save && pm2 startup   # auto-start on boot
```

Change the port: `PORT=8080 npm run start` or set `PORT=8080` in `server/.env`.

## Backups & restore

**Automatic backups.** The server writes a WAL-safe hot copy of the SQLite DB
(via better-sqlite3's native backup API) to `server/data/backups/` — once on
every boot and daily at 02:05. Only the newest 14 are kept (override with
`BACKUP_KEEP` in the environment). The folder is gitignored.

**Restore from a backup.** Stop the server first, then:

```bash
cd server
npm run restore                                # lists available backups
npm run restore -- choopi-20260704-020500.db   # restores that file
```

The script refuses to run while the server holds the DB, saves the current
live DB as `pre-restore-<timestamp>.db` before overwriting anything, and
finishes with an integrity check. Start the server again afterwards.

**JSON export / import.** `GET /api/settings/export` downloads the full
ledger as JSON (schema_version 2 — investments, transactions, snapshots, RSU
grants + vesting events). `POST /api/settings/import` restores such a file
onto your account: it takes a native DB backup first, then replaces your rows
in a single transaction (ids are remapped, other accounts untouched):

```bash
curl -b cookies.txt -X POST http://localhost:3001/api/settings/import \
  -H 'Content-Type: application/json' --data @choopi-backup-2026-07-04.json
```
