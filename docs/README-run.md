# Running Choopi Finance

Start, stop, update, back up, restore. The operational manual.

**The model:** one machine runs the server and owns the database. Your Mac, your
PC and your phone are all just browsers pointing at it. There is no syncing and
no second copy of the data — whatever the server says is the truth, and if the
server is off, nothing works. That is the trade for never having to reconcile
two divergent ledgers.

---

## First-time setup

```bash
cd choopi-finance
npm install

cp server/.env.example server/.env
sed -i '' "s/replace-with-a-long-random-secret/$(openssl rand -hex 32)/" server/.env

npm run setup:https    # optional but recommended — see docs/https-setup.md
mkcert -install        # run this yourself; it needs your password

npm start
```

On first open the app asks you to choose a passcode. That is the only account
this tracker will ever have; the setup screen closes permanently once it is set.

---

## Day to day

| Task | Command |
|---|---|
| Start (foreground) | `npm start` |
| Start with auto-restart on code changes | `npm run dev` |
| Stop | `Ctrl-C`, or see the service sections below |
| Back up now | `npm run backup` |
| List backups | `npm run restore` |
| Restore | `npm run restore -- <file>` → **[docs/restore.md](restore.md)** |
| Change the passcode | `npm run set-pin` |
| Regenerate the certificate | `npm run setup:https` |
| Run the tests | `npm test` |

`npm start` builds the server and serves both the API and the app on one port.
Front-end edits need no restart — the client is plain static files.

### The startup banner

Every start prints a box with the URL to open on your phone and the state of
everything that matters:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ CHOOPI FINANCE                                                           │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   On your phone, open:                                                   │
│                                                                          │
│       https://your-mac.local:3001                                        │
│                                                                          │
│   Also reachable at:                                                     │
│       https://192.168.1.42:3001   (en0)                                  │
│       https://localhost:3001   (this machine)                            │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│   TLS        HTTPS on — certificate covers 5 name(s)                     │
│              expires in 823 day(s)                                       │
│              http://192.168.1.42:3000/ca  → install the CA on a device   │
│   LAN guard  ON — private ranges + localhost only                        │
│   Passcode   set (server/config/pin.json)                                │
│   Database   ~/…/choopi-finance/server/data/choopi.db                    │
│                                                                          │
│   Never forward this port on your router. Private network only.          │
└──────────────────────────────────────────────────────────────────────────┘
```

If TLS says OFF, or the passcode says NOT SET, the banner tells you before you
find out from a phone.

---

## Keeping it running across reboots

### macOS — launchd (recommended on a Mac)

launchd is already there, needs nothing installed, and restarts the process if
it dies.

```bash
cp deploy/com.choopi.finance.plist ~/Library/LaunchAgents/
# edit the four EDIT ME paths inside, then:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.choopi.finance.plist
```

| Task | Command |
|---|---|
| Status | `launchctl print gui/$(id -u)/com.choopi.finance \| head -20` |
| Stop | `launchctl bootout gui/$(id -u)/com.choopi.finance` |
| Start | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.choopi.finance.plist` |
| Restart | `launchctl kickstart -k gui/$(id -u)/com.choopi.finance` |
| Logs | `tail -f server/data/choopi.log` |

**Build before you rely on it.** The agent runs `server/dist/index.js`, so run
`npm run build` after any server change.

**Two Mac-specific gotchas:**

- A **user agent** starts at *login*, not at boot. On an always-on Mac that is
  usually fine; if not, turn on automatic login, or move the plist to
  `/Library/LaunchDaemons` and add a `UserName` key.
- **Sleep stops everything.** A sleeping Mac is not a server. In
  *System Settings → Energy* (or *Battery → Options* on a laptop), enable
  "Prevent automatic sleeping when the display is off". The app catches up on
  wake — recurring deposits and vesting both re-run on start and nightly — but
  it cannot answer your phone while asleep.

### pm2 (macOS, Linux, or if you already use it)

```bash
npm install -g pm2
cd choopi-finance
npm run build
pm2 start server/dist/index.js --name choopi
pm2 save
pm2 startup          # prints a command to run — it needs sudo
```

| Task | Command |
|---|---|
| Status | `pm2 status` |
| Stop | `pm2 stop choopi` |
| Start | `pm2 start choopi` |
| Restart | `pm2 restart choopi` |
| Logs | `pm2 logs choopi` |

### Linux — systemd

```ini
# ~/.config/systemd/user/choopi.service
[Unit]
Description=Choopi Finance
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/YOU/choopi-finance
ExecStart=/usr/bin/node /home/YOU/choopi-finance/server/dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now choopi
loginctl enable-linger $USER      # so it runs when you're not logged in
journalctl --user -u choopi -f
```

---

## Updating

```bash
cd choopi-finance
npm run backup          # always, before anything
git pull                # if you're tracking it in git
npm install             # picks up dependency and asset changes
npm run build
```

Then restart however you run it (`pm2 restart choopi`, `launchctl kickstart -k …`).

Database migrations run automatically on start and are recorded, so an upgrade
that adds a migration applies it once. Applied migrations are fingerprinted and
immutable — if one has been edited since it ran, the server refuses to start
rather than silently diverging.

**If an update goes wrong:** you took a backup in step one. See
[docs/restore.md](restore.md).

---

## Backups

Automatic:

- **on every server start** (skipped if one was taken in the last 12 hours, so
  restarts don't churn the retention window)
- **nightly at 02:05**

Each run writes a pair — a `VACUUM INTO` snapshot and the whole ledger as JSON —
verifies the snapshot with `PRAGMA integrity_check`, and prunes. Retention keeps
the newest **30 daily** plus the newest of each of the last **12 months**.

Manual: `npm run backup`, or **Settings → Backups → Back up now** in the app,
which also gives you per-backup download links for both files.

Tune in `server/.env`:

```env
BACKUP_KEEP_DAILY=30
BACKUP_KEEP_MONTHLY=12
```

Getting copies off the machine matters more than any of this — see
[docs/restore.md §7](restore.md#7-getting-backups-off-this-machine).

---

## Access control

Three independent layers, in order:

**1. Don't forward the port.** No port forwarding, no UPnP, no DMZ host, no
public reverse proxy. This is the one that actually matters; the others are
there for when this one fails.

**2. The LAN guard.** Every request's source address must be inside
`192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12` or loopback. Anything else gets
a bare 403. It reads the socket address and ignores `X-Forwarded-For` entirely,
because a header the caller controls is not evidence.

```env
LAN_ONLY=true                      # default; only the literal "false" disables it
LAN_ALLOW_EXTRA=100.64.0.0/10      # e.g. a Tailscale subnet you trust
```

**3. The passcode.** A PIN, bcrypt-hashed, stored in `server/config/pin.json`
(gitignored, `chmod 600`) or in `APP_PIN_HASH`. It stops the housemate, the
guest phone and the smart TV that are all legitimately on your wifi. Wrong
guesses are rate-limited and lock that device out for 15 minutes after 8
failures.

Forgotten it? `npm run set-pin` on the host machine.

---

## Adding another device

Nothing to install and nothing to configure — it is a website.

1. Make sure the device is on the same wifi.
2. Open the URL from the startup banner.
3. Enter the passcode.
4. Optional: trust the CA and install it as an app —
   [docs/https-setup.md](https-setup.md).

All devices see the same data because there is only one copy of it. Change
something on your phone and the Mac shows it on the next load.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Phone can't reach it at all | Different wifi network, or guest network isolation | Check the phone is on the same SSID; some routers isolate guest networks |
| `.local` name doesn't resolve | Android/Windows mDNS | Use the IP from the banner instead |
| Certificate warning | CA not trusted on that device | [docs/https-setup.md](https-setup.md) |
| Worked yesterday, "can't reach the server" today | Mac asleep, or the LAN IP changed | Wake it; if the IP moved, re-run `npm run setup:https` and set a DHCP reservation |
| 403 "only answers on the local network" | Source address outside the private ranges — VPN on the phone is the usual culprit | Turn the VPN off, or add its range to `LAN_ALLOW_EXTRA` |
| Signed out on every device at once | `JWT_SECRET` changed | Expected; sign in again |
| "Add to Home Screen" gives a bookmark, not an app | Plain HTTP — no service worker | Set up HTTPS, or accept it: [docs/https-setup.md](https-setup.md) |
| Server won't start: JWT_SECRET error | No `server/.env` | `cp server/.env.example server/.env` and set a real secret |
| Server won't start: migration checksum | An applied migration file was edited | Restore it, or restore the database from a backup |

Logs are wherever your service manager puts them — `server/data/choopi.log` for
the launchd template, `pm2 logs choopi` for pm2, `journalctl --user -u choopi`
for systemd.
