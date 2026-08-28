/**
 * Settings: the knobs, the FX table, and the ways data gets in and out.
 *
 * The FX table lives here rather than on its own screen because it is the one
 * piece of manual data that isn't owned by an account — every mixed-currency
 * total in the app depends on it, and nothing else does.
 */

import { api } from "../api.js";
import { state, setTheme, setCurrency } from "../state.js";
import {
  h, render, frag, field, select, segmented, textInput, numberInput, dateInput,
  moneyInput, iconEl, toast, errorToast, openSheet, editSheet, deleteWithUndo,
  emptyState, spinner,
} from "../ui.js";
import { dateLabel, agoLabel, parseNumber, todayIso } from "../fmt.js";
import { installState } from "../pwa.js";
import { refresh } from "../app.js";

export async function settingsScreen() {
  const [{ settings, backups }, fx] = await Promise.all([
    api.settings.get(),
    api.fx.list({ limit: 12 }),
  ]);

  const node = h("div.stack",
    displayCard(settings),
    backupCard(backups),
    fxCard(fx),
    calculationCard(settings),
    securityCard(),
    dataCard(),
    aboutCard(),
  );

  return { title: "Settings", node };
}

const kb = (bytes) => `${Math.round((bytes ?? 0) / 1024).toLocaleString()} KB`;

/**
 * Backups.
 *
 * This is the panel that matters at 2am, so it shows the things you would want
 * to know then: when the last one ran, how many exist, and two links per
 * backup — the .db to restore from and the .json that outlives SQLite itself.
 */
function backupCard(summary) {
  const latest = summary?.latest ?? null;
  const list = summary?.backups ?? [];

  const rows = h("div");
  if (!list.length) {
    rows.append(h("div", { style: { padding: "var(--sp-4)" } }, emptyState({
      title: "No backups yet",
      hint: "One is taken on every server start and nightly at 02:05. You can also take one right now.",
      icon: "save",
    })));
  } else {
    for (const b of list.slice(0, 8)) {
      rows.append(h("div.backup-row",
        h("div.backup-row__main",
          h("div.backup-row__when", { text: `${dateLabel(b.taken_at.slice(0, 10), { year: true })} · ${b.taken_at.slice(11, 16)}` }),
          h("div.backup-row__meta", {
            text: `${kb(b.size_bytes)}${b.json ? " · database + JSON" : " · database only"}`,
          }),
        ),
        h("div.backup-row__links",
          h("a", { href: api.backups.downloadUrl(b.db), download: "" }, ".db"),
          b.json && h("a", { href: api.backups.downloadUrl(b.json), download: "" }, ".json"),
        ),
      ));
    }
  }

  return h("div.card.card--flush",
    h("div", { style: { padding: "var(--sp-4) var(--sp-4) var(--sp-3)" } },
      h("div.card__title", { text: "Backups", style: { marginBottom: "var(--sp-1)" } }),
      h("div.faint", { style: { fontSize: "var(--text-sm)" },
        text: latest
          ? `Last backup ${agoLabel(latest.takenAt.slice(0, 10))} · ${summary.total} kept ` +
            `(${summary.keep_daily} daily, ${summary.keep_monthly} monthly)`
          : "Nightly at 02:05, and once on every server start." }),
    ),

    h("div", { style: { padding: "0 var(--sp-4) var(--sp-3)" } },
      h("div.btn-row",
        h("button.btn.btn--primary", {
          type: "button",
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.textContent = "Backing up…";
            try {
              const r = await api.backups.run();
              toast(`Backed up — ${kb(r.sizeBytes)}, integrity check passed`);
              refresh();
            } catch (err) { errorToast(err); btn.disabled = false; }
          },
        }, iconEl("save"), "Back up now"),

        latest
          ? h("a.btn", { href: api.backups.downloadUrl(latest.db), download: "" },
              iconEl("download"), "Download")
          : h("button.btn", { type: "button", disabled: true }, iconEl("download"), "Download"),
      ),
    ),

    rows,

    h("div", { style: { padding: "var(--sp-3) var(--sp-4)", borderTop: "1px solid var(--border)" } },
      h("div.faint", { style: { fontSize: "var(--text-sm)" },
        text: "To restore one, follow docs/restore.md on the machine that hosts this." }),
    ),
  );
}

/**
 * Security: the passcode, and an honest read on whether this page is actually
 * installable. A PWA that silently isn't one is the failure mode worth naming.
 */
function securityCard() {
  const pwa = installState();

  const httpsNotice = pwa.secure
    ? h("div.notice.notice--ok",
        h("span.notice__icon", iconEl("check")),
        h("div", pwa.standalone
          ? h("span", h("strong", { text: "Installed. " }), "Running as a standalone app.")
          : h("span", h("strong", { text: "Secure connection. " }),
              "Use your browser's Share → Add to Home Screen to install it.")),
      )
    : h("div.notice.notice--warn",
        h("span.notice__icon", iconEl("alert")),
        h("div",
          h("strong", { text: "Not a secure context. " }),
          `This page is on ${pwa.protocol}//${pwa.host}, so the browser will not run a ` +
          "service worker. Add to Home Screen still works, but it will be a bookmark " +
          "rather than an offline app. Run `npm run setup:https` on the host to fix it.",
        ),
      );

  return h("div.card.card--flush",
    h("div", { style: { padding: "var(--sp-4) var(--sp-4) var(--sp-3)" } },
      h("div.card__title", { text: "Security & install" }),
      httpsNotice,
    ),

    h("div.setting",
      h("div.setting__text",
        h("div.setting__title", { text: "Passcode" }),
        h("div.setting__sub", { text: "Asked for on every device that opens this app." }),
      ),
      h("button.btn.btn--sm", { type: "button", onclick: openChangePin }, "Change"),
    ),

    h("div.setting",
      h("div.setting__text",
        h("div.setting__title", { text: "Lock now" }),
        h("div.setting__sub", { text: "Clears the session on this device only." }),
      ),
      h("button.btn.btn--sm", {
        type: "button",
        onclick: async () => { await api.auth.lock(); location.reload(); },
      }, "Lock"),
    ),
  );
}

function openChangePin() {
  const current = h("input.input", {
    type: "password", inputmode: "numeric", autocomplete: "current-password",
    placeholder: "Current passcode",
  });
  const next = h("input.input", {
    type: "password", inputmode: "numeric", autocomplete: "new-password",
    placeholder: "New passcode",
  });
  const repeat = h("input.input", {
    type: "password", inputmode: "numeric", autocomplete: "new-password",
    placeholder: "Repeat new passcode",
  });

  editSheet({
    title: "Change passcode",
    control: h("div.stack",
      field("Current passcode", current),
      field("New passcode", next, { hint: "4–12 digits." }),
      field("Repeat it", repeat),
    ),
    parse: () => {
      if (next.value !== repeat.value) throw new Error("The new passcodes don't match");
      if (!/^\d{4,12}$/.test(next.value)) throw new Error("The passcode must be 4–12 digits");
      return { current_pin: current.value, new_pin: next.value };
    },
    onSave: async ({ current_pin, new_pin }) => {
      await api.auth.change(current_pin, new_pin);
      toast("Passcode changed — every other device has been signed out");
    },
  });
}

/** Persist one setting and re-render, reporting failure rather than silently reverting. */
async function save(patch, { after } = {}) {
  try {
    await api.settings.update(patch);
    after?.();
  } catch (err) {
    errorToast(err);
    refresh();
  }
}

// ── display ──────────────────────────────────────────────────────────────────

function displayCard(settings) {
  return h("div.card.card--flush",
    h("div", { style: { padding: "var(--sp-4) var(--sp-4) 0" } },
      h("div.card__title", { text: "Display" })),

    h("div.setting",
      h("div.setting__text",
        h("div.setting__title", { text: "Display currency" }),
        h("div.setting__sub", { text: "Every total and chart converts into this." }),
      ),
      segmented(
        [{ value: "ILS", label: "₪ ILS" }, { value: "USD", label: "$ USD" }],
        settings.display_currency,
        (value) => { setCurrency(value); save({ display_currency: value }, { after: refresh }); },
      ),
    ),

    h("div.setting",
      h("div.setting__text",
        h("div.setting__title", { text: "Theme" }),
        h("div.setting__sub", { text: "System follows your phone's light/dark setting." }),
      ),
      segmented(
        [{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "system", label: "Auto" }],
        settings.theme,
        (value) => { setTheme(value); save({ theme: value }); },
      ),
    ),
  );
}

// ── FX ───────────────────────────────────────────────────────────────────────

function fxCard(fx) {
  const rows = h("div.rows");

  if (!fx.rates.length) {
    rows.append(h("div", { style: { padding: "var(--sp-4)" } }, emptyState({
      title: "No exchange rates entered",
      hint: "Without a USD → ILS rate, dollar accounts are counted at 1:1 in shekel totals.",
      actionLabel: "Add a rate",
      onAction: () => openFxForm(null),
      icon: "repeat",
    })));
  } else {
    fx.rates.forEach((rate, i) => {
      const prev = fx.rates[i + 1];
      const change = prev ? ((rate.rate - prev.rate) / prev.rate) * 100 : null;
      rows.append(h("div.row",
        h("div.row__main",
          h("div.row__title", { text: dateLabel(rate.date, { year: true }) }),
          h("div.row__sub", {
            text: `${rate.base_currency} → ${rate.quote_currency}${change == null
              ? " · first rate entered"
              : ` · ${change >= 0 ? "+" : ""}${change.toFixed(2)}% vs previous`}`,
          }),
        ),
        h("button.tapedit.row__amount", {
          type: "button", onclick: () => openFxForm(rate),
        }, rate.rate.toFixed(4)),
        h("button.iconbtn.iconbtn--danger", {
          type: "button", "aria-label": "Delete rate",
          onclick: () => deleteWithUndo({
            label: "Rate",
            remove: () => api.fx.remove(rate.id),
            restore: (row) => api.fx.create(row),
            refresh,
          }),
        }, iconEl("trash")),
      ));
    });
  }

  return h("div.card.card--flush",
    h("div", { style: { padding: "var(--sp-4) var(--sp-4) var(--sp-3)" } },
      h("div.card__title", { text: "Exchange rates", style: { marginBottom: "var(--sp-1)" } }),
      h("div.faint", { style: { fontSize: "var(--text-sm)" },
        text: "Entered by hand. Any date uses the newest rate on or before it." }),
    ),
    rows,
    h("button.loadmore", { type: "button", onclick: () => openFxForm(null) }, "+ Add rate"),
  );
}

function openFxForm(rate) {
  const value = h("input.money__input", {
    type: "text", inputmode: "decimal", value: rate?.rate ?? "", placeholder: "3.72",
    onfocus: (e) => e.target.select(),
  });
  const wrap = h("div.money", h("span.money__prefix", { text: "₪" }), value,
    h("span.money__suffix", { text: "per $1" }));
  const date = dateInput({ value: rate?.date ?? todayIso() });

  editSheet({
    title: rate ? "Edit rate" : "Add exchange rate",
    control: h("div.stack", field("USD → ILS", wrap), field("Date", date)),
    parse: () => {
      const n = parseNumber(value.value);
      if (!n || n <= 0) throw new Error("Enter a rate, e.g. 3.72");
      return { rate: n, date: date.value, base_currency: "USD", quote_currency: "ILS" };
    },
    onSave: async (body) => {
      if (rate) await api.fx.update(rate.id, { rate: body.rate, date: body.date });
      else await api.fx.create(body);
      toast("Rate saved");
      refresh();
    },
    deleteAction: rate ? () => deleteWithUndo({
      label: "Rate",
      remove: () => api.fx.remove(rate.id),
      restore: (row) => api.fx.create(row),
      refresh,
    }) : null,
  });
}

// ── calculation ──────────────────────────────────────────────────────────────

function calculationCard(settings) {
  const staleDays = numberInput({ value: settings.stale_data_days, style: { maxWidth: "90px" } });
  staleDays.onchange = () => {
    const n = parseNumber(staleDays.value);
    if (!n || n < 1 || n > 365) { errorToast(new Error("Use a number of days between 1 and 365")); return; }
    save({ stale_data_days: String(Math.round(n)), stale_fx_days: String(Math.round(n)) },
      { after: () => toast("Threshold saved") });
  };

  return h("div.card.card--flush",
    h("div", { style: { padding: "var(--sp-4) var(--sp-4) 0" } },
      h("div.card__title", { text: "Calculation" })),

    h("div.setting",
      h("div.setting__text",
        h("div.setting__title", { text: "Flag data older than" }),
        h("div.setting__sub", { text: "How stale a price or balance gets before it shows up in Needs attention." }),
      ),
      h("div.rowline", staleDays, h("span.muted", { text: "days" })),
    ),

    h("div.setting",
      h("div.setting__text",
        h("div.setting__title", { text: "RSU cost basis" }),
        h("div.setting__sub", {
          text: settings.rsu_principal_basis === "vest_price"
            ? "Vested shares count as money you put in, at their price on the vest date."
            : "Vested shares cost you nothing, so all of their value counts as earnings.",
        }),
      ),
      segmented(
        [{ value: "zero_cost", label: "Free" }, { value: "vest_price", label: "At vest price" }],
        settings.rsu_principal_basis,
        (value) => save({ rsu_principal_basis: value }, { after: refresh }),
      ),
    ),
  );
}

// ── data ─────────────────────────────────────────────────────────────────────

const CSV_TABLES = [
  "accounts", "holdings", "transactions", "prices", "valuations",
  "fx_rates", "rsu_grants", "rsu_vests", "recurring_rules",
];

function dataCard() {
  return h("div.card.card--flush",
    h("div", { style: { padding: "var(--sp-4) var(--sp-4) 0" } },
      h("div.card__title", { text: "Export & import" })),

    h("div.setting",
      h("div.setting__text",
        h("div.setting__title", { text: "Export everything" }),
        h("div.setting__sub", { text: "One JSON file with the whole ledger — re-importable as-is." }),
      ),
      // A plain link: same-origin, so the session cookie rides along and the
      // browser saves the file itself.
      h("a.btn.btn--sm", { href: "/api/settings/export", download: "" },
        iconEl("download"), "Export"),
    ),

    h("div.setting",
      h("div.setting__text",
        h("div.setting__title", { text: "Import a ledger" }),
        h("div.setting__sub", { text: "Replaces everything. A backup is taken first, automatically." }),
      ),
      h("button.btn.btn--sm", { type: "button", onclick: openLedgerImport },
        iconEl("upload"), "Import"),
    ),

    h("div.setting",
      h("div.setting__text",
        h("div.setting__title", { text: "CSV" }),
        h("div.setting__sub", { text: "Export any table; bulk-load prices, balances and rates." }),
      ),
      h("button.btn.btn--sm", { type: "button", onclick: openCsvSheet }, "Open"),
    ),
  );
}

function openLedgerImport() {
  const file = h("input", { type: "file", accept: "application/json,.json", class: "input" });

  openSheet({
    title: "Import a ledger",
    build: () => h("div.stack",
      h("p", { text: "Pick a JSON file exported from this app. Everything currently stored is replaced." }),
      h("p.muted", { text: "A database backup is taken before anything is touched, so this is recoverable." }),
      field("File", file),
    ),
    footer: (close) => frag(
      h("button.btn", { type: "button", onclick: () => close() }, "Cancel"),
      h("button.btn.btn--danger", {
        type: "button",
        onclick: async (e) => {
          const btn = e.currentTarget;
          if (!file.files?.[0]) { errorToast(new Error("Choose a file first")); return; }
          btn.disabled = true;
          try {
            const payload = JSON.parse(await file.files[0].text());
            const r = await api.settings.importLedger(payload);
            close();
            toast(`Imported ${Object.values(r.imported).reduce((a, b) => a + b, 0)} rows`);
            refresh();
          } catch (err) { errorToast(err); btn.disabled = false; }
        },
      }, "Replace everything"),
    ),
  });
}

function openCsvSheet() {
  const table = select(CSV_TABLES.map(value => ({ value, label: value.replace(/_/g, " ") })),
    { value: "prices" });
  const link = h("a.btn.btn--block", { href: "/api/csv/prices", download: "" },
    iconEl("download"), "Download CSV");
  table.onchange = () => { link.href = `/api/csv/${table.value}`; };

  const importTable = select(
    [{ value: "prices", label: "Prices (symbol, date, price_minor)" },
     { value: "valuations", label: "Balances (account_name, date, balance_minor)" },
     { value: "fx_rates", label: "FX rates (date, base_currency, quote_currency, rate)" }],
    { value: "prices" },
  );
  const file = h("input", { type: "file", accept: "text/csv,.csv", class: "input" });

  openSheet({
    title: "CSV",
    build: () => h("div.stack",
      field("Export table", table),
      link,
      h("hr", { style: { border: 0, borderTop: "1px solid var(--border)" } }),
      field("Import into", importTable, {
        hint: "Amounts are in minor units — agorot for ILS, cents for USD. Rows with an existing date are updated, not duplicated.",
      }),
      field("File", file),
      h("button.btn.btn--primary.btn--block", {
        type: "button",
        onclick: async (e) => {
          const btn = e.currentTarget;
          if (!file.files?.[0]) { errorToast(new Error("Choose a CSV file first")); return; }
          btn.disabled = true;
          try {
            const r = await api.settings.importCsv(importTable.value, await file.files[0].text());
            toast(`Imported ${r.imported} rows into ${r.table}`);
            refresh();
          } catch (err) { errorToast(err); }
          btn.disabled = false;
        },
      }, iconEl("upload"), "Import CSV"),
    ),
  });
}

function aboutCard() {
  return h("div.card.stack.stack--tight",
    h("div.card__title", { text: "About" }),
    h("p.muted", { style: { fontSize: "var(--text-sm)" },
      text: "Choopi Finance runs entirely on your own machine. No prices, rates or balances are ever fetched from anywhere — every number here is one you typed in." }),
    h("p.faint", { style: { fontSize: "var(--text-sm)" },
      text: "Reachable from your phone at this machine's LAN address. Keep it off the public internet." }),
  );
}
