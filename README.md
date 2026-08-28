# Choopi Finance

A self-hosted personal investment tracker. Runs on your machine, reachable from
your phone over the LAN, and **never talks to anything on the internet**.

Every price, balance and exchange rate is one you typed in. There is no price
feed, no FX feed, no scraping and no third-party call at runtime — by design,
not by omission.

---

## The question it answers

For any account, and for the portfolio as a whole, at any date:

```
value  =  my money (net principal)  +  earnings
gross earnings  =  earnings  +  fees paid
```

Everything on screen is a view of that one identity.

---

## Stack

| Layer     | Tech                                                    |
|-----------|---------------------------------------------------------|
| Frontend  | Vanilla ES modules · Chart.js 4 · no build step         |
| Install   | PWA — manifest, icons, service worker (app shell only)  |
| Backend   | Node.js · Express · TypeScript                          |
| Database  | SQLite (better-sqlite3), money as INTEGER minor units   |
| Auth      | App passcode → signed httpOnly session cookie           |
| Network   | LAN-only guard · optional HTTPS via a local mkcert CA   |
| Fonts     | Hanken Grotesk · Spline Sans Mono (vendored locally)    |

The client is plain static files served by the same Express process that serves
the API. There is no bundler, no framework and nothing to rebuild after editing
a screen — reload the page and it's live. One process, one port, one URL on
your phone.

Chart.js and the two webfonts are copied out of `node_modules` into `web/` by
`scripts/sync-assets.mjs` (run automatically on `npm install`), so the app works
with the network unplugged.

---

## Getting started

```bash
cd choopi-finance
npm install

# one-time: a real signing secret
cp server/.env.example server/.env
sed -i '' "s/replace-with-a-long-random-secret/$(openssl rand -hex 32)/" server/.env

npm start
```

Open the URL the startup banner prints. On first visit you choose a **passcode**
— that is the only account this tracker will ever have, and the setup screen
closes permanently once it is set.

| Command             | What it does                                        |
|---------------------|-----------------------------------------------------|
| `npm start`         | Build the server and serve API + app on `:3001`     |
| `npm run dev`       | Same, restarting on server changes                  |
| `npm test`          | The calculation, guard and backup test suites       |
| `npm run backup`    | Take a backup now                                   |
| `npm run restore`   | List backups; `-- <file>` to restore one            |
| `npm run set-pin`   | Set or reset the passcode                           |
| `npm run setup:https` | Issue the local TLS certificate with mkcert       |

Front-end edits need no restart in either mode.

Full operational guide: **[docs/README-run.md](docs/README-run.md)**.

---

## Reaching it from your phone

The startup banner prints the exact URL:

```
   On your phone, open:

       https://your-mac.local:3001
```

Open it, enter the passcode, and **Add to Home Screen**.

For it to install as a *real* app rather than a bookmark it needs HTTPS, because
service workers only run in a secure context. One command sets that up:

```bash
npm run setup:https
mkcert -install      # run this yourself — it needs your password
```

Then trust the certificate authority on each device —
**[docs/https-setup.md](docs/https-setup.md)** has step-by-step instructions for
iOS, Android, macOS and Windows, and an honest table of what you give up if you
skip it.

### Keeping it off the internet

Three layers, in the order that matters:

1. **Never forward the port** on your router. No port forwarding, no UPnP, no
   DMZ, no public reverse proxy.
2. **The LAN guard** refuses any request from outside `192.168.0.0/16`,
   `10.0.0.0/8`, `172.16.0.0/12` and loopback. On by default; it reads the
   socket address and ignores `X-Forwarded-For`.
3. **The passcode** stops other devices that are legitimately on your wifi.
   Rate-limited, with a lockout after repeated wrong guesses.

---

## Screens

| Screen        | What it's for |
|---------------|---------------|
| **Dashboard** | Total value with a ILS/USD switch, the three headline numbers, the stacked principal-vs-earnings chart (3M/1Y/YTD/All), allocation donut, fees per month, and a "needs attention" strip for stale data and missing FX. |
| **Accounts**  | A card per account with value, principal, earnings and last-updated, sortable and filterable by category and funding mode. |
| **Account**   | The same decomposition scoped to one account, a value/return-% chart, recorded fees beside the estimate from the configured rates, and tabs for Transactions, Prices or Balances, Recurring rules and Settings — all inline-editable. |
| **RSUs**      | Per grant: vested, unvested, and what the vested part is worth. A vesting timeline (solid = vested, outlined = upcoming) and an editable table of vest events. |
| **Settings**  | Display currency, theme, the FX rate table, stale-data threshold, RSU cost basis, CSV and JSON import/export, manual backup. |

### The + button

Bottom-right, reachable by thumb on every screen. Two taps to a form, three to
a saved data point:

* **Add deposit** — account remembered from last time, contribution split shown
  for pension/hishtalmut/gemel.
* **Update price** — grouped by account, shows the last price you entered.
* **Update balance** — defaults to last month-end, which is how statements are dated.
* **Add fee** — management on balance, management on deposit, trading, other.
* **Add exchange rate** — USD → ILS.

Every form has **Save & add another**, which keeps the account and date so a
batch of month-end balances is a run of amount-tap-amount-tap.

### No dead ends

Every list row is tap-to-edit and has a delete. Deleting shows an **undo toast**,
not a confirmation modal — the row comes back exactly as it was, provenance
included. The single exception is deleting a whole account, which takes its
entire history with it and asks first.

---

## Project structure

```
choopi-finance/
├── web/                  # the app — plain static files, no build
│   ├── index.html
│   ├── css/              # tokens.css (design tokens) + app.css
│   ├── js/
│   │   ├── api.js        # the only place that talks to the server
│   │   ├── fmt.js        # minor units ⇄ what a person types and reads
│   │   ├── ui.js         # elements, sheets, undo toasts, form controls
│   │   ├── charts.js     # Chart.js wrappers, themed and phone-legible
│   │   ├── quickadd.js   # the + button's flow
│   │   └── screens/      # dashboard, accounts, account, rsu, settings, login
│   ├── vendor/           # chart.umd.js, copied from node_modules
│   └── fonts/            # woff2, copied from node_modules
│   ├── sw.js             # service worker — app shell only, never API data
│   ├── manifest.webmanifest
│   └── icons/            # generated by scripts/make-icons.mjs
├── server/
│   ├── migrations/       # versioned, immutable once applied
│   ├── certs/            # local TLS material (gitignored)
│   ├── config/           # passcode hash (gitignored)
│   ├── data/             # SQLite file + nightly backups (gitignored)
│   └── src/
│       ├── calc/         # the whole financial model, pure and tested
│       ├── net/          # LAN guard, TLS loading, startup banner
│       ├── security/     # passcode hashing and lockout
│       ├── services/     # backups and the ledger export format
│       ├── routes/       # the HTTP surface over calc/
│       └── db/           # connection + migration runner
├── deploy/               # launchd agent template
├── docs/                 # run, restore and HTTPS guides
└── scripts/              # asset vendoring, icon generation, mkcert setup
```

---

## Data model in one paragraph

Accounts are either **market-priced** (value = units held × the latest price you
entered, carried forward) or **balance-tracked** (value = the latest balance
snapshot). Money arrives **manually**, from a **salary** recurring rule that
posts itself, or not at all (**passive**). Net principal counts only flows that
cross the account boundary — deposits minus withdrawals — so buys, sells and
dividends never double-count. Fees are recorded as their own rows and also
estimated independently from the configured percentages, shown side by side so
the two can disagree visibly. Every account has its own currency; totals convert
using the newest manually-entered rate on or before each date.

Full detail: [`docs/schema.md`](docs/schema.md).

---

## Backups

Automatic on every server start and nightly at 02:05. Each run writes a **pair**
of files to `server/data/backups/`:

```
choopi-20260827-020500.db      VACUUM INTO snapshot — restores in one file copy
choopi-20260827-020500.json    the same ledger as text — survives SQLite itself
```

The snapshot is verified with `PRAGMA integrity_check` before anything is
pruned, and a failed check throws rather than leaving you with a backup that
silently didn't happen. Retention keeps the newest **30 daily** plus the newest
backup of each of the last **12 months**.

**Settings → Backups** has a *Back up now* button and download links for both
files of every backup.

Restoring is one command, and there is a runbook written to be followed at 2am:
**[docs/restore.md](docs/restore.md)**.

```bash
npm run restore                                  # list what you have
npm run restore -- choopi-20260827-020500.db     # restore it
```

It refuses to run while the server holds the database, saves the state it is
about to replace, checks integrity afterwards, and prints the row counts and
money sums before and after so you can see exactly what changed.

---

## Environment

`server/.env` (gitignored):

```env
PORT=3001
JWT_SECRET=<openssl rand -hex 32>
COOKIE_SECURE=false     # true only if you put it behind HTTPS
BACKUP_KEEP=14
```
