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
| Fonts     | Geist · JetBrains Mono · Instrument Serif (local) |

---

## Getting started

### Prerequisites

- Node.js 20+
- npm 10+

### Install & run

```bash
cd choopi-finance
npm install
npm run dev
```

This starts both processes concurrently:

| Process | URL                        |
|---------|----------------------------|
| Client  | http://localhost:5173       |
| Server  | http://localhost:3001       |
| Health  | http://localhost:3001/api/health |

The "Hello Choopi" smoke-test page confirms Instrument Serif italic, the brand gradient, and all design tokens are wired correctly.

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

| Font                | Package                          | Role              |
|---------------------|----------------------------------|-------------------|
| Geist               | `@fontsource-variable/geist`     | UI, body, headings |
| JetBrains Mono      | `@fontsource-variable/jetbrains-mono` | All numeric output |
| Instrument Serif    | `@fontsource/instrument-serif`   | Display only (italic) |

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
