# Restoring the database

**Read this top to bottom. It is written to be followed while half asleep.**

Nothing here is destructive until step 4, and even step 4 saves what it is about
to replace. You can stop at any point before then and nothing changes.

---

## 0. The one-minute version

```bash
cd ~/path/to/choopi-finance
pm2 stop choopi          # or: launchctl bootout gui/$(id -u)/com.choopi.finance
npm run restore          # lists what you have
npm run restore -- choopi-20260827-020500.db
pm2 start choopi         # or: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.choopi.finance.plist
```

Then open the app and check the dashboard total. Done.

The rest of this document explains what each step does and what to do when
something is different from the happy path.

---

## 1. Work out what you are recovering from

| What happened | What to do |
|---|---|
| I deleted or edited the wrong thing in the app | Restore the most recent backup from *before* you did it. |
| The app won't start, database errors in the log | Restore the most recent backup, any one. |
| The file is gone / disk died / new machine | Restore the newest backup you still have (see §7 for off-machine copies). |
| The numbers look wrong but I don't know when it started | Restore into a *scratch* copy first — §6 — and compare before touching the live one. |

Backups live in:

```
choopi-finance/server/data/backups/
```

Each backup is a **pair** of files with the same name:

```
choopi-20260827-020500.db      the database — fast, exact, restores in one copy
choopi-20260827-020500.json    the same ledger as text — the insurance policy
```

Prefer the `.db`. Use the `.json` only if the `.db` is missing or won't open
(§5). Both produce identical numbers — that is verified by the test suite and
was verified by hand when this was built.

Retention keeps the **newest 30 daily** backups plus the **newest backup of each
of the last 12 months**, so you have roughly a month of days and a year of
month-ends.

---

## 2. Stop the server

The restore script refuses to run while anything holds the database open. This
is deliberate: overwriting a file SQLite is actively writing to is how you turn
one bad night into two.

Pick whichever you used to set it up:

```bash
pm2 stop choopi
```

```bash
launchctl bootout gui/$(id -u)/com.choopi.finance
```

Or just `Ctrl-C` in the terminal that is running it.

Confirm nothing is listening any more:

```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN
```

No output means you are clear.

---

## 3. See what you have

```bash
cd ~/path/to/choopi-finance
npm run restore
```

```
Backups in /…/server/data/backups:

  choopi-20260827-020500.db          8/27/2026, 2:05:00 AM         172 KB   + .json
  choopi-20260826-020500.db          8/26/2026, 2:05:00 AM         171 KB   + .json
  choopi-20260731-020500.db          7/31/2026, 2:05:00 AM         168 KB   + .json
  …
```

Pick the newest one from **before** whatever went wrong. Backups run at 02:05,
so "yesterday's backup" is the state of the ledger as of ~2am that morning —
anything you entered later that day is not in it.

---

## 4. Restore

```bash
npm run restore -- choopi-20260827-020500.db
```

What it does, in order:

1. Checks nothing holds the database (fails fast if the server is still up).
2. **Copies your current database to `backups/pre-restore-<timestamp>.db`.**
   This is your undo. If you restore the wrong night, that file is the state you
   just replaced.
3. Deletes the stale `-wal` / `-shm` sidecars — leaving them would graft the old
   journal onto the new file.
4. Copies the backup into place.
5. Runs `PRAGMA integrity_check`.
6. Prints the row counts and money sums, before and after.

You will see something like:

```
  Current database saved to pre-restore-20260828132700.db
  Copying choopi-20260827-020500.db over the live database …

✓ Restored from choopi-20260827-020500.db — integrity check ok

  what                        before        after
  ────────────────────────────────────────────────
  accounts                            7            7
  transactions                      109          108   ←
  sum_deposits_minor           85924200     85609200   ←
  …
```

The `←` marks show what changed. That is your confirmation that you restored
what you meant to.

---

## 5. If the `.db` won't open

Use the JSON sidecar. It contains every row as text and does not depend on
SQLite's file format at all:

```bash
npm run restore -- choopi-20260827-020500.json
```

This builds a **fresh** database from the migrations and imports the JSON into
it, so it works even if the old file is corrupt beyond opening. It produces the
same numbers — the round trip is covered by a test that wipes the ledger and
rebuilds it from JSON alone.

It is slower (seconds rather than milliseconds) and it needs the schema to still
understand the export's `schema_version`. Current version: **3**.

---

## 6. Inspecting a backup without touching the live one

When you are not sure which backup you want, look before you leap:

```bash
cd server/data/backups
sqlite3 choopi-20260827-020500.db \
  "SELECT COUNT(*) FROM transactions;
   SELECT SUM(amount_minor) FROM transactions WHERE type='deposit';
   SELECT name, category FROM accounts;"
```

Or read the JSON, which needs no tools at all:

```bash
python3 -m json.tool choopi-20260827-020500.json | head -40
```

Amounts are **integer minor units** — agorot for ILS, cents for USD. `85609200`
is ₪856,092.00.

---

## 7. Getting backups off this machine

Everything above assumes the machine still exists. A backup that only lives on
the disk it is protecting is not a backup.

The backups directory is plain files, so any sync tool works. Point one of these
at `server/data/backups/`:

- **iCloud Drive / Dropbox / Google Drive** — symlink the folder in, or set
  `BACKUP_DIR`-style syncing at the filesystem level.
- **Time Machine** — it is already covered if it backs up your home directory.
- **A second machine**, nightly:

  ```bash
  rsync -av ~/path/to/choopi-finance/server/data/backups/ \
        backup-box:~/choopi-backups/
  ```

You can also just download the latest pair from **Settings → Backups** on your
phone once a month and let it sit in your files. The `.json` is small and
readable forever.

---

## 8. Start the server again

```bash
pm2 start choopi
# or
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.choopi.finance.plist
# or
npm start
```

Open the app and check the dashboard total against what you expected. If the
numbers are right, you are done.

---

## 9. If you restored the wrong one

Your previous state is in `backups/pre-restore-<timestamp>.db`. Restore it the
same way:

```bash
npm run restore -- pre-restore-20260828132700.db
```

`pre-restore-*` files are never pruned automatically. Delete them by hand once
you are sure you don't need them.

---

## 10. Things that are NOT in a backup

A backup contains the ledger and the app settings. It does **not** contain:

- **The passcode** — `server/config/pin.json`. Recreate it with `npm run set-pin`.
- **`server/.env`** — including `JWT_SECRET`. Losing it just signs everyone out;
  generate a new one with `openssl rand -hex 32`.
- **TLS certificates** — `server/certs/`. Regenerate with `npm run setup:https`.

None of those are financial data, and all three are one command to recreate. But
if you are moving to a new machine, copy `server/.env` across too so your
sessions survive.
