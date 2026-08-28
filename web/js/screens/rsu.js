/**
 * RSUs.
 *
 * A grant is a promise on a schedule, so the screen is built around the
 * schedule: what has vested, what is coming, and what the vested part is worth
 * at the last price anyone bothered to write down.
 *
 * price_at_vest is manually entered by design — nothing here can look up a
 * historical close — and it is the cost basis for the units that tranche
 * released, so it earns a first-class editable column.
 */

import { api } from "../api.js";
import { state } from "../state.js";
import {
  h, render, frag, field, iconEl, emptyState, toast, errorToast, openSheet,
  editSheet, deleteWithUndo, moneyInput, textInput, numberInput, dateInput,
  select, spinner,
} from "../ui.js";
import {
  money, units, pct, dateLabel, agoLabel, symbolOf, parseMoney, parseNumber,
  toInputValue, todayIso,
} from "../fmt.js";
import { FREQUENCY, cssVar } from "../labels.js";
import { vestingBarChart, legend } from "../charts.js";
import { refresh } from "../app.js";

export async function rsuScreen() {
  const { grants, as_of } = await api.rsu.overview({});
  const node = h("div.stack");

  if (!grants.length) {
    const { accounts } = await api.accounts.list({ currency: state.currency });
    const rsuAccounts = accounts.filter(a => a.category === "rsu");

    node.append(h("div.card", emptyState({
      title: "No RSU grants yet",
      hint: rsuAccounts.length
        ? "Add a grant with its cliff and vesting period, and every tranche gets laid out for you."
        : "RSU grants live inside an account of category RSU. Create one first, then add the grant.",
      icon: "grant",
      actionLabel: rsuAccounts.length ? "Add a grant" : "Go to accounts",
      onAction: () => {
        if (rsuAccounts.length) openGrantForm(rsuAccounts, null, () => refresh());
        else location.hash = "#/accounts";
      },
    })));
    return { title: "RSUs", node };
  }

  node.append(totalsCard(grants, as_of));
  for (const grant of grants) node.append(grantCard(grant, as_of));

  node.append(h("button.btn.btn--block", {
    type: "button",
    onclick: async () => {
      const { accounts } = await api.accounts.list({ currency: state.currency });
      openGrantForm(accounts.filter(a => a.category === "rsu"), null, () => refresh());
    },
  }, iconEl("plus"), "Add grant"));

  return { title: "RSUs", node };
}

// ── portfolio-level totals ───────────────────────────────────────────────────

function totalsCard(grants, asOf) {
  const vested = grants.reduce((s, g) => s + g.net_vested_units, 0);
  const unvested = grants.reduce((s, g) => s + g.unvested_units, 0);
  const valued = grants.filter(g => g.vested_value_minor != null);
  const currency = valued[0]?.currency ?? "USD";
  const value = valued.reduce((s, g) => s + g.vested_value_minor, 0);
  const mixedCurrency = new Set(valued.map(g => g.currency)).size > 1;

  const next = grants
    .map(g => g.next_vest)
    .filter(Boolean)
    .sort((a, b) => a.vest_date.localeCompare(b.vest_date))[0];

  return h("div.card.stack",
    h("div.hero__label", { text: "Vested and held" }),
    h("div.hero__row",
      h("div.hero__value", {
        text: mixedCurrency ? units(vested) : money(value, currency, { decimals: false }),
      }),
    ),

    h("div.kpis",
      h("div.kpi",
        h("div.kpi__label", { text: "Vested" }),
        h("div.kpi__value", { text: units(vested) }),
        h("div.kpi__sub", { text: "Units, net of tax sales" }),
      ),
      h("div.kpi",
        h("div.kpi__label", { text: "Unvested" }),
        h("div.kpi__value", { text: units(unvested) }),
        h("div.kpi__sub", { text: "Not valued in totals" }),
      ),
      h("div.kpi",
        h("div.kpi__label", { text: "Next vest" }),
        h("div.kpi__value", { text: next ? dateLabel(next.vest_date) : "—" }),
        h("div.kpi__sub", { text: next ? `${units(next.units)} units` : "Fully vested" }),
      ),
    ),

    h("div.faint", { style: { fontSize: "var(--text-xs)" },
      text: `As of ${dateLabel(asOf, { year: true })}. Unvested units are counted separately and never valued.` }),
  );
}

// ── one grant ────────────────────────────────────────────────────────────────

function grantCard(grant, asOf) {
  const chartBox = h("div.chart");
  const tableBox = h("div");

  const priced = grant.last_price_minor != null;
  const sourceNote = grant.last_price_source === "holding"
    ? `Priced from the ${grant.symbol} holding, ${agoLabel(grant.last_price_date)}`
    : grant.last_price_source === "vest"
      ? "Priced from the most recent vest price you entered"
      : "No price yet — enter a price at vest, or add a matching holding";

  const card = h("div.card.stack",
    h("div.card__head",
      h("div",
        h("div.card__title", { text: grant.symbol, style: { fontSize: "var(--text-md)" } }),
        h("div.faint", { style: { fontSize: "var(--text-sm)" },
          text: `Granted ${dateLabel(grant.grant_date, { year: true })} · ${units(grant.total_units)} units · ${FREQUENCY[grant.vest_frequency]} over ${grant.vest_duration_months}mo${grant.cliff_months ? `, ${grant.cliff_months}mo cliff` : ""}` }),
      ),
      h("span.spacer"),
      h("button.iconbtn", {
        type: "button", "aria-label": "Edit grant",
        onclick: async () => {
          const { accounts } = await api.accounts.list({ currency: state.currency });
          openGrantForm(accounts.filter(a => a.category === "rsu"), grant, () => refresh());
        },
      }, iconEl("pencil")),
    ),

    h("div.kpis",
      h("div.kpi",
        h("div.kpi__label", { text: "Vested" }),
        h("div.kpi__value", { text: units(grant.net_vested_units) }),
        h("div.kpi__sub", {
          text: grant.units_sold_to_cover_tax
            ? `${units(grant.vested_units)} less ${units(grant.units_sold_to_cover_tax)} for tax`
            : "Units",
        }),
      ),
      h("div.kpi",
        h("div.kpi__label", { text: "Unvested" }),
        h("div.kpi__value", { text: units(grant.unvested_units) }),
        h("div.kpi__sub", {
          text: grant.next_vest ? `Next ${dateLabel(grant.next_vest.vest_date)}` : "None left",
        }),
      ),
      h("div.kpi",
        h("div.kpi__label", { text: "Value" }),
        h("div.kpi__value", {
          class: priced ? "" : "faint",
          text: priced ? money(grant.vested_value_minor, grant.currency, { decimals: false }) : "—",
        }),
        h("div.kpi__sub", {
          text: priced ? `at ${money(grant.last_price_minor, grant.currency)}` : "No price",
        }),
      ),
    ),

    h("div.faint", { style: { fontSize: "var(--text-xs)" }, text: sourceNote }),

    chartBox,
    legend([
      { color: cssVar("--accent"), label: "Vested" },
      { color: cssVar("--accent"), label: "Upcoming", hollow: true },
    ]),

    tableBox,
  );

  requestAnimationFrame(() => vestingBarChart(chartBox, { vests: grant.vests, asOf }));
  render(tableBox, vestTable(grant, asOf));
  return card;
}

/**
 * The tranche table. Both manually-entered columns — price at vest and units
 * sold to cover withholding — are tap-to-edit in place, because they arrive
 * from a brokerage statement one line at a time.
 */
function vestTable(grant, asOf) {
  const reload = () => refresh();

  // Most recent first: the tranche you just got the paperwork for is the one
  // you came here to type in.
  const ordered = [...grant.vests].sort((a, b) => b.vest_date.localeCompare(a.vest_date));

  const rows = h("div.rows");
  for (const vest of ordered) {
    const isPast = vest.vest_date <= asOf;
    const net = vest.units - vest.units_sold_to_cover_tax;

    rows.append(h("div.row",
      h("div.row__main",
        h("div.row__title", { text: dateLabel(vest.vest_date, { year: true }) }),
        h("div.row__sub", {
          text: [
            `${units(vest.units)} units`,
            vest.units_sold_to_cover_tax ? `${units(vest.units_sold_to_cover_tax)} sold for tax → ${units(net)} net` : null,
            isPast ? "vested" : "upcoming",
          ].filter(Boolean).join(" · "),
        }),
      ),
      h("button.tapedit.row__amount", {
        type: "button",
        class: vest.price_at_vest_minor == null ? "faint" : "",
        onclick: () => openVestEditor(vest, grant, reload),
      }, vest.price_at_vest_minor == null
          ? "Set price"
          : money(vest.price_at_vest_minor, grant.currency)),
      h("button.iconbtn.iconbtn--danger", {
        type: "button", "aria-label": "Delete tranche",
        onclick: () => deleteWithUndo({
          label: "Tranche",
          remove: () => api.rsu.removeVest(vest.vest_id),
          restore: () => { throw new Error("Re-add it from the grant's schedule"); },
          refresh: reload,
        }),
      }, iconEl("trash")),
    ));
  }

  return h("div.card.card--flush", { style: { marginTop: "var(--sp-2)" } },
    h("div", { style: { padding: "var(--sp-3) var(--sp-4)", borderBottom: "1px solid var(--border)" } },
      h("div.card__title", { text: "Vest events", style: { margin: 0 } }),
      h("div.faint", { style: { fontSize: "var(--text-sm)" },
        text: "Tap a price to record what the share was worth on the vest date." }),
    ),
    rows,
  );
}

function openVestEditor(vest, grant, reload) {
  const price = moneyInput({
    symbol: symbolOf(grant.currency),
    value: vest.price_at_vest_minor == null ? "" : toInputValue(vest.price_at_vest_minor),
    suffix: `per unit · ${grant.currency}`,
  });
  const unitCount = numberInput({ value: vest.units });
  const sold = numberInput({ value: vest.units_sold_to_cover_tax });
  const date = dateInput({ value: vest.vest_date });
  const status = select(
    [{ value: "scheduled", label: "Scheduled" },
     { value: "vested", label: "Vested" },
     { value: "cancelled", label: "Cancelled" }],
    { value: vest.status },
  );

  editSheet({
    title: `${grant.symbol} — ${dateLabel(vest.vest_date, { year: true })}`,
    subtitle: "Vest tranche",
    control: h("div.stack",
      field("Price at vest", price, {
        hint: "What one share was worth on the day it vested. This is the cost basis for these units.",
      }),
      field("Units vesting", unitCount),
      field("Units sold to cover tax", sold, {
        hint: "Shares your employer sold on the day to cover withholding. The rest is what you actually hold.",
      }),
      field("Vest date", date),
      field("Status", status),
    ),
    parse: () => {
      const u = parseNumber(unitCount.value);
      const s = parseNumber(sold.value) ?? 0;
      if (!u || u <= 0) throw new Error("Units must be greater than zero");
      if (s > u) throw new Error("Units sold for tax can't exceed the units that vested");
      return {
        price_at_vest_minor: price.input.value.trim() === "" ? null : parseMoney(price.input.value),
        units: u,
        units_sold_to_cover_tax: s,
        vest_date: date.value,
        status: status.value,
      };
    },
    onSave: async (body) => {
      await api.rsu.updateVest(vest.vest_id, body);
      toast("Vest updated");
      await reload();
    },
  });
}

// ── grant form ───────────────────────────────────────────────────────────────

function openGrantForm(rsuAccounts, grant, onSaved) {
  if (!rsuAccounts.length) {
    return openSheet({
      title: "No RSU account",
      build: () => emptyState({
        title: "Create an RSU account first",
        hint: "Grants hang off an account of category RSU, so the vested shares can be valued alongside everything else.",
        actionLabel: "Go to accounts",
        onAction: () => { location.hash = "#/accounts"; },
      }),
    });
  }

  const editing = Boolean(grant);
  const account = select(
    rsuAccounts.map(a => ({ value: a.account_id ?? a.id, label: a.name })),
    { value: grant?.account_id ?? rsuAccounts[0].account_id },
  );
  const symbol = textInput({
    value: grant?.symbol ?? "", placeholder: "ACME", autocapitalize: "characters",
  });
  const grantDate = dateInput({ value: grant?.grant_date ?? todayIso() });
  const totalUnits = numberInput({ value: grant?.total_units ?? "", placeholder: "4000" });
  const grantPrice = moneyInput({
    symbol: symbolOf(grant?.currency ?? "USD"),
    value: grant?.grant_price_minor == null ? "" : toInputValue(grant.grant_price_minor),
    suffix: "at grant",
  });
  const currency = select(
    [{ value: "USD", label: "$ USD" }, { value: "ILS", label: "₪ ILS" }],
    { value: grant?.currency ?? "USD" },
  );
  const cliff = numberInput({ value: grant?.cliff_months ?? 12 });
  const duration = numberInput({ value: grant?.vest_duration_months ?? 48 });
  const frequency = select(
    Object.entries(FREQUENCY).map(([value, label]) => ({ value, label })),
    { value: grant?.vest_frequency ?? "quarterly" },
  );

  editSheet({
    title: editing ? "Edit grant" : "New RSU grant",
    control: h("div.stack",
      field("Account", account),
      field("Symbol", symbol),
      field("Grant date", grantDate),
      field("Total units", totalUnits),
      field("Vests over (months)", duration),
      field("Cliff (months)", cliff, {
        hint: "Everything accrued before the cliff is released in one tranche on the cliff date.",
      }),
      field("Vests every", frequency),
      field("Currency", currency),
      field("Price at grant", grantPrice, {
        hint: "Reference only. Cost basis comes from each tranche's price at vest.",
      }),
      editing && h("div.field__hint", {
        text: "Changing the dates, units, cliff, duration or frequency rebuilds the schedule — prices you entered on existing tranches will be lost.",
      }),
    ),
    parse: () => {
      const total = parseNumber(totalUnits.value);
      const cliffM = parseNumber(cliff.value) ?? 0;
      const durationM = parseNumber(duration.value);
      if (!symbol.value.trim()) throw new Error("Enter the ticker symbol");
      if (!total || total <= 0) throw new Error("Enter the total number of units");
      if (!durationM || durationM < 1) throw new Error("Enter how many months it vests over");
      if (cliffM > durationM) throw new Error("The cliff can't be longer than the whole vesting period");
      return {
        account_id: Number(account.value),
        symbol: symbol.value.trim().toUpperCase(),
        grant_date: grantDate.value,
        total_units: total,
        grant_price_minor: grantPrice.input.value.trim() === "" ? null : parseMoney(grantPrice.input.value),
        currency: currency.value,
        cliff_months: cliffM,
        vest_duration_months: durationM,
        vest_frequency: frequency.value,
      };
    },
    onSave: async (body) => {
      if (editing) {
        const r = await api.rsu.updateGrant(grant.id, body);
        toast(r.regenerated ? `Grant saved — ${r.tranches} tranches rebuilt` : "Grant saved");
      } else {
        const r = await api.rsu.createGrant(body);
        toast(`Grant added — ${r.tranches} tranches scheduled`);
      }
      onSaved();
    },
    deleteAction: editing ? () => deleteWithUndo({
      label: `${grant.symbol} grant`,
      remove: () => api.rsu.removeGrant(grant.id),
      restore: (row) => api.rsu.createGrant(row),
      refresh: onSaved,
    }) : null,
  });
}
