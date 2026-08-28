/**
 * Account detail.
 *
 * The header repeats the dashboard's three numbers scoped to this account, then
 * a chart with a Value / Return% toggle, then the fee reconciliation, then the
 * tabs that hold the actual rows.
 *
 * Tab contents load on demand and replace only their own container: switching
 * from Transactions to Prices must not re-fetch the chart or lose your scroll.
 */

import { api } from "../api.js";
import { state } from "../state.js";
import {
  h, render, frag, segmented, field, iconEl, emptyState, toast, errorToast,
  openSheet, editSheet, deleteWithUndo, moneyInput, textInput, numberInput,
  dateInput, select, spinner,
} from "../ui.js";
import {
  money, moneyCompact, pct, units, dateLabel, agoLabel, symbolOf,
  parseMoney, parseNumber, toInputValue, todayIso,
} from "../fmt.js";
import {
  categoryFull, TX_TYPE, FEE_KIND, FEE_KIND_SHORT, CONTRIBUTION_PART,
  FREQUENCY, FUNDING_MODE, VALUATION_MODE, cssVar,
} from "../labels.js";
import { stackedAreaChart, returnLineChart, legend } from "../charts.js";
import { openQuickAdd } from "../quickadd.js";
import { openAccountForm } from "./account-form.js";
import { categoryBadge } from "./accounts.js";
import { refresh } from "../app.js";

const PAGE = 25;

const RANGES = [
  { value: "3M", label: "3M" }, { value: "1Y", label: "1Y" },
  { value: "YTD", label: "YTD" }, { value: "ALL", label: "All" },
];

function readQuery() {
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  return {
    tab: q.get("tab") ?? "transactions",
    chart: q.get("chart") ?? "value",
    range: q.get("range") ?? state.range,
  };
}

function writeQuery(id, next) {
  const q = new URLSearchParams({ ...readQuery(), ...next });
  location.hash = `#/accounts/${id}?${q}`;
}

export async function accountScreen(idParam) {
  const id = Number(idParam);
  const currency = state.currency;
  const query = readQuery();

  const [detail, series] = await Promise.all([
    api.accounts.get(id, { currency }),
    api.accounts.series(id, { currency, range: query.range }),
  ]);

  const { account, summary, holdings } = detail;
  const isMarket = account.valuation_mode === "market";

  const node = h("div.stack",
    headerCard(account, summary, currency),
    chartCard(id, series, summary, currency, query),
    feesCard(account, summary, currency),
    projectionCard(id, account),
    tabsSection(id, account, holdings, summary, currency, query),
  );

  return { title: account.name, back: "#/accounts", node };
}

// ── header ───────────────────────────────────────────────────────────────────

function headerCard(account, summary, currency) {
  const up = summary.net_earnings_minor >= 0;
  const converted = account.currency !== currency;

  return h("div.card.stack",
    h("div.rowline.rowline--wrap",
      categoryBadge(account.category),
      h("span.badge", { text: VALUATION_MODE[account.valuation_mode].label }),
      h("span.badge", { text: FUNDING_MODE[account.funding_mode].label }),
      account.institution && h("span.badge", { text: account.institution }),
    ),

    h("div.hero__row",
      h("div.hero__value", { text: money(summary.value_display_minor, currency, { decimals: false }) }),
    ),

    converted && h("div.faint", {
      style: { fontSize: "var(--text-sm)", marginTop: "calc(var(--sp-2) * -1)" },
      text: `${money(summary.value_minor, account.currency, { decimals: false })} converted at ${summary.fx_rate_used.toFixed(4)}`,
    }),

    h("div.kpis",
      h("div.kpi",
        h("div.kpi__label", { text: "My money" }),
        h("div.kpi__value", { text: money(summary.net_principal_display_minor, currency, { decimals: false }) }),
        h("div.kpi__sub", { text: "Net principal" }),
      ),
      h("div.kpi",
        h("div.kpi__label", { text: "Earnings" }),
        h("div.kpi__value", { class: up ? "pos" : "neg",
          text: money(summary.net_earnings_display_minor, currency, { decimals: false, sign: true }) }),
        h("div.kpi__sub", { text: pct(summary.simple_return_pct) }),
      ),
      h("div.kpi",
        h("div.kpi__label", { text: "Annualised" }),
        h("div.kpi__value", { text: pct(summary.money_weighted_return_pct) }),
        h("div.kpi__sub", { text: "Money-weighted" }),
      ),
    ),

    h("div.faint", {
      style: { fontSize: "var(--text-xs)" },
      text: summary.last_data_date
        ? `${account.valuation_mode === "balance" ? "Balance" : "Price"} last updated ${agoLabel(summary.last_data_date)} · ${dateLabel(summary.last_data_date, { year: true })}`
        : "No price or balance has been entered yet.",
    }),

    h("div.btn-row",
      h("button.btn.btn--primary", {
        type: "button",
        onclick: () => openQuickAdd({
          initial: account.valuation_mode === "balance" ? "balance" : "price",
          accountId: account.id,
          onDone: () => refresh(),
        }),
      }, iconEl(account.valuation_mode === "balance" ? "balance" : "price"),
        account.valuation_mode === "balance" ? "Add balance" : "Add price"),
      h("button.btn", {
        type: "button",
        onclick: () => openQuickAdd({ initial: "deposit", accountId: account.id, onDone: () => refresh() }),
      }, iconEl("deposit"), "Add deposit"),
    ),
  );
}

// ── chart ────────────────────────────────────────────────────────────────────

function chartCard(id, series, summary, currency, query) {
  const box = h("div.chart.chart--tall");

  const draw = () => {
    if (query.chart === "return") returnLineChart(box, { points: series.points });
    else stackedAreaChart(box, { points: series.points, currency });
  };

  const card = h("div.card.stack",
    segmented(
      [{ value: "value", label: "My money vs earnings" }, { value: "return", label: "Return %" }],
      query.chart,
      (v) => writeQuery(id, { chart: v }),
      { full: true },
    ),
    segmented(RANGES, query.range, (v) => writeQuery(id, { range: v }), { full: true }),
    box,
    query.chart === "value"
      ? legend([
          { color: cssVar("--accent"), label: "My money",
            value: moneyCompact(summary.net_principal_display_minor, currency) },
          { color: cssVar(summary.net_earnings_display_minor >= 0 ? "--emerald" : "--rose"),
            label: summary.net_earnings_display_minor >= 0 ? "Earnings" : "Loss",
            value: moneyCompact(summary.net_earnings_display_minor, currency) },
        ])
      : h("div.faint", { style: { fontSize: "var(--text-sm)" },
          text: "Simple return: earnings as a share of the money you put in, at each date." }),
  );

  requestAnimationFrame(draw);
  return card;
}

// ── fees ─────────────────────────────────────────────────────────────────────

/**
 * Recorded fees next to the estimate implied by the configured percentages.
 *
 * They are meant to disagree — the estimate is a smell test. A balance-tracked
 * pension already has its fees baked into the statement figure, so anything you
 * record there would double-count; the card says so rather than showing a gap
 * and letting you draw the wrong conclusion.
 */
function feesCard(account, summary, currency) {
  const paid = summary.fees_paid_display_minor;
  const estimated = summary.fees_estimated_display_minor;
  const hasRates = account.mgmt_fee_balance_pct != null || account.mgmt_fee_deposit_pct != null;

  return h("div.card.stack.stack--tight",
    h("div.card__head", h("div.card__title", { text: "Fees" })),

    h("div.kpis",
      h("div.kpi",
        h("div.kpi__label", { text: "Recorded" }),
        h("div.kpi__value", { text: money(paid, currency) }),
        h("div.kpi__sub", { text: "Fees you entered" }),
      ),
      h("div.kpi",
        h("div.kpi__label", { text: "Estimated" }),
        h("div.kpi__value", { class: hasRates ? "" : "faint", text: hasRates ? money(estimated, currency) : "—" }),
        h("div.kpi__sub", {
          text: hasRates
            ? [account.mgmt_fee_balance_pct != null && `${account.mgmt_fee_balance_pct}%/yr`,
               account.mgmt_fee_deposit_pct != null && `${account.mgmt_fee_deposit_pct}% in`]
              .filter(Boolean).join(" · ")
            : "No rates set",
        }),
      ),
      h("div.kpi",
        h("div.kpi__label", { text: "Fee drag" }),
        h("div.kpi__value", {
          text: summary.gross_earnings_display_minor
            ? `${((paid / summary.gross_earnings_display_minor) * 100).toFixed(1)}%`
            : "—",
        }),
        h("div.kpi__sub", { text: "Of gross earnings" }),
      ),
    ),

    account.valuation_mode === "balance" && h("div.field__hint", {
      text: "Your statement balance already has management fees deducted, so recorded fees here are for visibility — they are not subtracted again.",
    }),

    !hasRates && h("button.btn.btn--sm", {
      type: "button",
      onclick: () => openAccountForm({ account, onSaved: () => refresh() }),
    }, "Set fee rates"),
  );
}

// ── projection ───────────────────────────────────────────────────────────────

/**
 * The compound-interest calculator: this account, carried forward under an
 * assumed return, with its own fees dragging and its recurring rules
 * contributing. Labelled a projection in the card itself — the one number in
 * the app that is an assumption rather than a record.
 */
function projectionCard(id, account) {
  const YEARS = [5, 10, 20, 30];
  let years = 10;

  const rate = numberInput({
    value: "6", style: { maxWidth: "110px", textAlign: "center" },
    "aria-label": "Assumed annual return, percent",
  });
  const body = h("div.stack.stack--tight");

  async function run() {
    render(body, spinner());
    try {
      const r = await api.accounts.projection(id, {
        years, annual_return_pct: parseNumber(rate.value) ?? 6,
      });
      const rows = r.points.filter(pt => pt.month > 0 && pt.month % 60 === 0 || pt.month === years * 12);
      render(body,
        h("div.kpis",
          h("div.kpi",
            h("div.kpi__label", { text: `In ${years} years` }),
            h("div.kpi__value", { text: money(r.final.value_minor, r.currency, { decimals: false }) }),
            h("div.kpi__sub", { text: "Projected value" }),
          ),
          h("div.kpi",
            h("div.kpi__label", { text: "You'd put in" }),
            h("div.kpi__value", { text: money(r.final.principal_minor, r.currency, { decimals: false }) }),
            h("div.kpi__sub", {
              text: r.assumptions.monthly_contribution_minor
                ? `${money(r.assumptions.monthly_contribution_minor, r.currency, { decimals: false })}/mo from rules`
                : "No recurring deposits",
            }),
          ),
          h("div.kpi",
            h("div.kpi__label", { text: "Growth − fees" }),
            h("div.kpi__value", { class: r.final.earnings_minor >= 0 ? "pos" : "neg",
              text: money(r.final.earnings_minor, r.currency, { decimals: false, sign: true }) }),
            h("div.kpi__sub", { text: `Fees ≈ ${money(r.final.fees_minor, r.currency, { decimals: false })}` }),
          ),
        ),
        h("div.rows",
          ...r.points.filter(pt => pt.month > 0 && pt.month % 12 === 0)
            .filter((_, i, arr) => arr.length <= 6 || i % Math.ceil(arr.length / 6) === 0 || i === arr.length - 1)
            .map(pt => h("div.row", { style: { minHeight: "44px", padding: "var(--sp-2) 0" } },
              h("div.row__main", h("div.row__sub", { text: `Year ${pt.month / 12}` })),
              h("div.row__amount", { text: money(pt.value_minor, r.currency, { decimals: false }) }),
            )),
        ),
      );
    } catch (err) {
      render(body, h("div.field__hint", { text: err.message }));
    }
  }

  rate.onchange = run;
  const card = h("div.card.stack",
    h("div.card__head", h("div.card__title", { text: "If it keeps growing…" })),
    h("div.rowline.rowline--wrap",
      field("Assumed return %/yr", rate),
      h("span.spacer"),
      segmented(YEARS.map(y => ({ value: String(y), label: `${y}y` })), String(years),
        (v) => { years = Number(v); run(); }),
    ),
    body,
    h("div.faint", { style: { fontSize: "var(--text-xs)" },
      text: "A projection from your assumptions — not a forecast. Uses this account's fee rates and recurring deposits." }),
  );

  run();
  return card;
}

// ── tabs ─────────────────────────────────────────────────────────────────────

function tabsSection(id, account, holdings, summary, currency, query) {
  const isMarket = account.valuation_mode === "market";
  const tabs = [
    { key: "transactions", label: "Transactions" },
    { key: "series", label: isMarket ? "Prices" : "Balances" },
    { key: "recurring", label: "Recurring rules" },
    { key: "settings", label: "Settings" },
  ];

  const panel = h("div.card.card--flush", spinner());

  const bar = h("div.tabs", { role: "tablist" },
    ...tabs.map(t => h("button.tab", {
      type: "button", role: "tab",
      "aria-selected": t.key === query.tab,
      onclick: () => {
        for (const b of bar.children) b.setAttribute("aria-selected", "false");
        bar.querySelector(`[data-tab="${t.key}"]`).setAttribute("aria-selected", "true");
        // Replace the hash without re-running the router: the tab owns its
        // own content, and a full navigation would rebuild the chart.
        const q = new URLSearchParams({ ...readQuery(), tab: t.key });
        history.replaceState(null, "", `#/accounts/${id}?${q}`);
        loadTab(t.key);
      },
      dataset: { tab: t.key },
    }, t.label)),
  );

  async function loadTab(key) {
    render(panel, spinner());
    try {
      // Tabs get `refresh` — a whole-screen re-render — as their reload hook,
      // not a panel-only one. Deleting a transaction changes the headline
      // numbers and the chart above it, and a panel that quietly disagreed
      // with the total above it would be worse than a rebuilt chart.
      const view = await TABS[key](id, account, holdings, summary, currency, refresh);
      render(panel, view);
    } catch (err) {
      render(panel, h("div.row", h("div.row__main", h("div.row__title", { text: err.message }))));
    }
  }

  loadTab(query.tab);
  return h("div.stack.stack--tight", bar, panel);
}

const TABS = {
  transactions: transactionsTab,
  series: seriesTab,
  recurring: recurringTab,
  settings: settingsTab,
};

// ── transactions tab ─────────────────────────────────────────────────────────

async function transactionsTab(id, account, holdings, summary, currency, reload) {
  let offset = 0;
  const list = h("div.rows");
  const wrap = h("div", list);

  async function loadPage() {
    const page = await api.transactions.list({ account_id: id, limit: PAGE, offset });
    if (offset === 0 && page.total === 0) {
      render(wrap, h("div", { style: { padding: "var(--sp-4)" } }, emptyState({
        title: "No transactions yet",
        hint: account.funding_mode === "salary"
          ? "Set up a recurring rule and monthly deposits will post themselves."
          : "Add a deposit from the + button, and it'll show up here.",
        actionLabel: "Add deposit",
        onAction: () => openQuickAdd({ initial: "deposit", accountId: id, onDone: () => refresh() }),
        icon: "deposit",
      })));
      return;
    }

    for (const tx of page.transactions) list.append(txRow(tx, account, holdings, reload));
    offset += page.transactions.length;

    wrap.querySelector(".loadmore")?.remove();
    if (page.has_more) {
      wrap.append(h("button.loadmore", { type: "button", onclick: (e) => {
        e.currentTarget.textContent = "Loading…";
        loadPage();
      } }, `Load ${Math.min(PAGE, page.total - offset)} more of ${page.total}`));
    } else if (page.total > PAGE) {
      wrap.append(h("div.row", h("div.faint.spacer", {
        style: { textAlign: "center", fontSize: "var(--text-sm)" },
        text: `All ${page.total} transactions shown`,
      })));
    }
  }

  await loadPage();
  return wrap;
}

function txRow(tx, account, holdings, reload) {
  const meta = TX_TYPE[tx.type] ?? { label: tx.type, direction: "either" };
  const inflow = tx.amount_minor > 0;

  const subtitle = [
    dateLabel(tx.date, { year: true }),
    tx.holding_symbol && `${tx.holding_symbol} · ${units(tx.quantity)} @ ${money(tx.price_minor, tx.currency)}`,
    tx.fee_kind && FEE_KIND_SHORT[tx.fee_kind],
    tx.contribution_part && CONTRIBUTION_PART[tx.contribution_part].replace(/\s*\(.*\)/, ""),
    tx.source === "recurring" && "Auto",
    tx.note,
  ].filter(Boolean).join(" · ");

  return h("div.row",
    h("div.row__main",
      h("div.row__title", { text: meta.label }),
      h("div.row__sub", { text: subtitle }),
    ),
    h("button.tapedit.row__amount", {
      type: "button",
      class: tx.type === "fee" ? "" : inflow ? "pos" : "neg",
      onclick: () => openTxEditor(tx, account, holdings, reload),
    }, money(tx.amount_minor, tx.currency, { sign: true })),
    h("button.iconbtn.iconbtn--danger", {
      type: "button", "aria-label": "Delete transaction",
      onclick: () => deleteWithUndo({
        label: meta.label,
        remove: () => api.transactions.remove(tx.id),
        restore: (row) => api.transactions.restore(row),
        refresh: reload,
      }),
    }, iconEl("trash")),
  );
}

/**
 * Editing a transaction re-opens the same fields that created it. Trades carry
 * units and a price; fees carry a kind; deposits into an Israeli savings
 * product carry a contribution split — the sheet shows only what applies.
 */
function openTxEditor(tx, account, holdings, reload) {
  const isTrade = tx.type === "buy" || tx.type === "sell";
  const amount = moneyInput({
    symbol: symbolOf(tx.currency),
    value: toInputValue(Math.abs(tx.amount_minor)),
    suffix: tx.currency,
  });
  const date = dateInput({ value: tx.date });
  const note = textInput({ value: tx.note ?? "", placeholder: "Optional note" });

  const quantity = isTrade ? numberInput({ value: tx.quantity ?? "" }) : null;
  const price = isTrade
    ? moneyInput({ symbol: symbolOf(tx.currency), value: toInputValue(tx.price_minor) })
    : null;
  const feeKind = tx.type === "fee"
    ? select(Object.entries(FEE_KIND).map(([value, label]) => ({ value, label })), { value: tx.fee_kind })
    : null;
  const part = tx.type === "deposit"
    ? select([{ value: "", label: "Not split" },
        ...Object.entries(CONTRIBUTION_PART).map(([value, label]) => ({ value, label }))],
        { value: tx.contribution_part ?? "" })
    : null;

  editSheet({
    title: `Edit ${(TX_TYPE[tx.type]?.label ?? tx.type).toLowerCase()}`,
    subtitle: account.name,
    control: h("div.stack",
      field("Amount", amount),
      field("Date", date),
      isTrade && field("Units", quantity),
      isTrade && field("Price per unit", price),
      feeKind && field("Fee kind", feeKind),
      part && field("Which part?", part),
      field("Note", note),
    ),
    parse: () => {
      const amount_minor = parseMoney(amount.input.value);
      if (!amount_minor) throw new Error("Enter an amount");
      const body = { amount_minor: Math.abs(amount_minor), date: date.value, note: note.value || null };
      if (isTrade) {
        body.quantity = parseNumber(quantity.value);
        body.price_minor = parseMoney(price.input.value);
        body.holding_id = tx.holding_id;
        if (!body.quantity) throw new Error("Enter the number of units");
      }
      if (feeKind) body.fee_kind = feeKind.value;
      if (part) body.contribution_part = part.value || null;
      return body;
    },
    onSave: async (body) => {
      await api.transactions.update(tx.id, body);
      toast("Transaction updated");
      await reload();
    },
    deleteAction: () => deleteWithUndo({
      label: TX_TYPE[tx.type]?.label ?? "Transaction",
      remove: () => api.transactions.remove(tx.id),
      restore: (row) => api.transactions.restore(row),
      refresh: reload,
    }),
  });
}

// ── prices / balances tab ────────────────────────────────────────────────────

async function seriesTab(id, account, holdings, summary, currency, reload) {
  return account.valuation_mode === "market"
    ? pricesTab(id, account, holdings, reload)
    : balancesTab(id, account, reload);
}

async function balancesTab(id, account, reload) {
  let offset = 0;
  const list = h("div.rows");
  const wrap = h("div", list);

  async function loadPage() {
    const page = await api.valuations.list({ account_id: id, limit: PAGE, offset });
    if (offset === 0 && page.total === 0) {
      render(wrap, h("div", { style: { padding: "var(--sp-4)" } }, emptyState({
        title: "No balances recorded",
        hint: "Copy the balance off your latest statement — it's the only thing this account needs to be valued.",
        actionLabel: "Add balance",
        onAction: () => openQuickAdd({ initial: "balance", accountId: id, onDone: () => refresh() }),
        icon: "balance",
      })));
      return;
    }

    page.valuations.forEach((v, i) => {
      const prev = page.valuations[i + 1];
      const change = prev ? v.balance_minor - prev.balance_minor : null;
      list.append(h("div.row",
        h("div.row__main",
          h("div.row__title", { text: dateLabel(v.date, { year: true }) }),
          h("div.row__sub", {
            class: change == null ? "" : change >= 0 ? "pos" : "neg",
            text: change == null ? "First recorded balance"
              : `${money(change, v.currency, { sign: true })} since previous`,
          }),
        ),
        h("button.tapedit.row__amount", {
          type: "button",
          onclick: () => openBalanceEditor(v, account, reload),
        }, money(v.balance_minor, v.currency, { decimals: false })),
        h("button.iconbtn.iconbtn--danger", {
          type: "button", "aria-label": "Delete balance",
          onclick: () => deleteWithUndo({
            label: "Balance",
            remove: () => api.valuations.remove(v.id),
            restore: (row) => api.valuations.create(row),
            refresh: reload,
          }),
        }, iconEl("trash")),
      ));
    });

    offset += page.valuations.length;
    wrap.querySelector(".loadmore")?.remove();
    if (page.has_more) {
      wrap.append(h("button.loadmore", { type: "button", onclick: () => loadPage() },
        `Load ${Math.min(PAGE, page.total - offset)} more of ${page.total}`));
    }
  }

  await loadPage();
  return wrap;
}

function openBalanceEditor(v, account, reload) {
  const amount = moneyInput({
    symbol: symbolOf(v.currency), value: toInputValue(v.balance_minor), suffix: v.currency,
  });
  const date = dateInput({ value: v.date });

  editSheet({
    title: "Edit balance",
    subtitle: account.name,
    control: h("div.stack", field("Balance", amount), field("Date", date)),
    parse: () => {
      const balance_minor = parseMoney(amount.input.value);
      if (balance_minor == null || balance_minor < 0) throw new Error("Enter the balance");
      return { balance_minor, date: date.value };
    },
    onSave: async (body) => {
      await api.valuations.update(v.id, body);
      toast("Balance updated");
      await reload();
    },
    deleteAction: () => deleteWithUndo({
      label: "Balance",
      remove: () => api.valuations.remove(v.id),
      restore: (row) => api.valuations.create(row),
      refresh: reload,
    }),
  });
}

async function pricesTab(id, account, holdings, reload) {
  if (!holdings.length) {
    return h("div", { style: { padding: "var(--sp-4)" } }, emptyState({
      title: "No holdings in this account",
      hint: "Add the symbols you hold — a holding is what a price series hangs on.",
      actionLabel: "Add holding",
      onAction: () => openHoldingForm(id, null, () => refresh()),
      icon: "price",
    }));
  }

  const wrap = h("div");
  const picker = h("select.select", { onchange: () => showHolding(picker.value) });
  for (const holding of holdings) {
    picker.append(h("option", { value: holding.id },
      `${holding.symbol}${holding.display_name ? ` — ${holding.display_name}` : ""}`));
  }

  const head = h("div", { style: { padding: "var(--sp-4)", borderBottom: "1px solid var(--border)" } },
    field("Holding", picker),
    h("div.rowline", { style: { marginTop: "var(--sp-3)" } },
      h("button.btn.btn--sm", {
        type: "button",
        onclick: () => openQuickAdd({
          initial: "price", holdingId: Number(picker.value), onDone: () => refresh(),
        }),
      }, iconEl("plus"), "Add price"),
      h("button.btn.btn--sm", {
        type: "button",
        onclick: () => {
          const holding = holdings.find(x => String(x.id) === picker.value);
          openHoldingForm(id, holding, () => refresh());
        },
      }, iconEl("pencil"), "Edit holding"),
      h("span.spacer"),
    ),
  );

  const body = h("div");
  wrap.append(head, body);

  async function showHolding(holdingId) {
    render(body, spinner());
    const holding = holdings.find(x => String(x.id) === String(holdingId));
    let offset = 0;
    const list = h("div.rows");
    const inner = h("div", list);
    render(body, inner);

    async function loadPage() {
      const page = await api.prices.list({ holding_id: holdingId, limit: PAGE, offset });
      if (offset === 0 && page.total === 0) {
        render(inner, h("div", { style: { padding: "var(--sp-4)" } }, emptyState({
          title: `No prices for ${holding.symbol}`,
          hint: "Until a price is entered, this holding counts as zero in every total.",
          actionLabel: "Add price",
          onAction: () => openQuickAdd({ initial: "price", holdingId: Number(holdingId), onDone: () => refresh() }),
          icon: "price",
        })));
        return;
      }

      page.prices.forEach((p, i) => {
        const prev = page.prices[i + 1];
        const change = prev && prev.price_minor
          ? ((p.price_minor - prev.price_minor) / prev.price_minor) * 100 : null;
        list.append(h("div.row",
          h("div.row__main",
            h("div.row__title", { text: dateLabel(p.date, { year: true }) }),
            h("div.row__sub", {
              class: change == null ? "" : change >= 0 ? "pos" : "neg",
              text: change == null ? "First recorded price" : `${pct(change)} since previous`,
            }),
          ),
          h("button.tapedit.row__amount", {
            type: "button",
            onclick: () => openPriceEditor(p, holding, refresh),
          }, money(p.price_minor, p.currency)),
          h("button.iconbtn.iconbtn--danger", {
            type: "button", "aria-label": "Delete price",
            onclick: () => deleteWithUndo({
              label: "Price",
              remove: () => api.prices.remove(p.id),
              restore: (row) => api.prices.create(row),
              refresh,
            }),
          }, iconEl("trash")),
        ));
      });

      offset += page.prices.length;
      inner.querySelector(".loadmore")?.remove();
      if (page.has_more) {
        inner.append(h("button.loadmore", { type: "button", onclick: () => loadPage() },
          `Load ${Math.min(PAGE, page.total - offset)} more of ${page.total}`));
      }
    }
    await loadPage();
  }

  await showHolding(holdings[0].id);
  return wrap;
}

function openPriceEditor(p, holding, reload) {
  const amount = moneyInput({
    symbol: symbolOf(p.currency), value: toInputValue(p.price_minor), suffix: "per unit",
  });
  const date = dateInput({ value: p.date });

  editSheet({
    title: `Edit ${holding.symbol} price`,
    control: h("div.stack", field("Price", amount), field("Date", date)),
    parse: () => {
      const price_minor = parseMoney(amount.input.value);
      if (price_minor == null || price_minor < 0) throw new Error("Enter a price");
      return { price_minor, date: date.value };
    },
    onSave: async (body) => {
      await api.prices.update(p.id, body);
      toast("Price updated");
      await reload();
    },
    deleteAction: () => deleteWithUndo({
      label: "Price",
      remove: () => api.prices.remove(p.id),
      restore: (row) => api.prices.create(row),
      refresh: reload,
    }),
  });
}

function openHoldingForm(accountId, holding, onSaved) {
  const symbol = textInput({ value: holding?.symbol ?? "", placeholder: "VOO", autocapitalize: "characters" });
  const name = textInput({ value: holding?.display_name ?? "", placeholder: "Optional — full name" });
  const assetClass = select(
    [{ value: "stock", label: "Stock" }, { value: "etf", label: "ETF" }, { value: "crypto", label: "Crypto" }],
    { value: holding?.asset_class ?? "etf" },
  );
  const currency = select(
    [{ value: "ILS", label: "₪ ILS" }, { value: "USD", label: "$ USD" }],
    { value: holding?.currency ?? "USD" },
  );

  editSheet({
    title: holding ? "Edit holding" : "Add holding",
    control: h("div.stack",
      field("Symbol", symbol, { hint: "Your own label — nothing validates it against a market." }),
      field("Name", name),
      field("Asset class", assetClass),
      field("Priced in", currency),
    ),
    parse: () => {
      if (!symbol.value.trim()) throw new Error("Enter a symbol");
      return {
        symbol: symbol.value.trim().toUpperCase(),
        display_name: name.value.trim() || null,
        asset_class: assetClass.value,
        currency: currency.value,
      };
    },
    onSave: async (body) => {
      if (holding) await api.holdings.update(holding.id, body);
      else await api.accounts.addHolding(accountId, body);
      toast(holding ? "Holding updated" : `${body.symbol} added`);
      onSaved();
    },
    deleteAction: holding ? () => deleteWithUndo({
      label: holding.symbol,
      remove: () => api.holdings.remove(holding.id),
      restore: (row) => api.accounts.addHolding(accountId, row),
      refresh: onSaved,
    }) : null,
  });
}

// ── recurring tab ────────────────────────────────────────────────────────────

async function recurringTab(id, account, holdings, summary, currency, reload) {
  const [{ rules }, { upcoming }] = await Promise.all([
    api.recurring.list({ account_id: id }),
    api.recurring.upcoming({ months: 3 }),
  ]);

  const wrap = h("div");

  if (!rules.length) {
    wrap.append(h("div", { style: { padding: "var(--sp-4)" } }, emptyState({
      title: "No recurring rules",
      hint: account.funding_mode === "salary"
        ? "This account is salary-funded — add the monthly deposit once and it posts itself from then on."
        : "Add a rule if a fixed amount goes in on the same day each month.",
      actionLabel: "Add rule",
      onAction: () => openRuleForm(id, account, null, reload),
      icon: "repeat",
    })));
    return wrap;
  }

  const list = h("div.rows");
  for (const rule of rules) {
    const next = upcoming.find(u => u.rule_id === rule.id);
    list.append(h("div.row",
      h("div.row__main",
        h("div.row__title", { text: rule.label ?? `${FREQUENCY[rule.frequency]} deposit` }),
        h("div.row__sub", {
          text: [
            `${FREQUENCY[rule.frequency]} on day ${rule.day_of_month}`,
            rule.contribution_part && CONTRIBUTION_PART[rule.contribution_part].replace(/\s*\(.*\)/, ""),
            rule.is_active ? (next ? `next ${dateLabel(next.date, { year: true })}` : "no more due") : "paused",
            `${rule.posted_count} posted`,
          ].filter(Boolean).join(" · "),
        }),
      ),
      h("button.tapedit.row__amount", {
        type: "button",
        onclick: () => openRuleForm(id, account, rule, reload),
      }, money(rule.amount_minor, rule.currency, { decimals: false })),
      h("button.iconbtn.iconbtn--danger", {
        type: "button", "aria-label": "Delete rule",
        onclick: () => deleteWithUndo({
          label: "Rule",
          remove: () => api.recurring.remove(rule.id),
          // Deposits it already posted survive the delete, so restoring the
          // rule must not re-post them: the watermark starts from today.
          restore: (row) => api.recurring.create({ ...row, account_id: id, backfill: false }),
          refresh: reload,
        }),
      }, iconEl("trash")),
    ));
  }

  wrap.append(list, h("button.loadmore", {
    type: "button", onclick: () => openRuleForm(id, account, null, reload),
  }, "+ Add another rule"));

  return wrap;
}

function openRuleForm(accountId, account, rule, reload) {
  const editing = Boolean(rule);
  const label = textInput({ value: rule?.label ?? "", placeholder: "e.g. Employee 6%" });
  const amount = moneyInput({
    symbol: symbolOf(rule?.currency ?? account.currency),
    value: rule ? toInputValue(rule.amount_minor) : "",
    suffix: rule?.currency ?? account.currency,
  });
  const frequency = select(
    Object.entries(FREQUENCY).map(([value, l]) => ({ value, label: l })),
    { value: rule?.frequency ?? "monthly" },
  );
  const day = numberInput({ value: rule?.day_of_month ?? 1 });
  const part = select(
    [{ value: "", label: "Not split" },
     ...Object.entries(CONTRIBUTION_PART).map(([value, l]) => ({ value, label: l }))],
    { value: rule?.contribution_part ?? "" },
  );
  const start = dateInput({ value: rule?.start_date ?? todayIso() });
  const end = dateInput({ value: rule?.end_date ?? "" });
  const active = h("input", { type: "checkbox", checked: rule ? rule.is_active === 1 : true });
  const backfill = h("input", { type: "checkbox" });

  editSheet({
    title: editing ? "Edit rule" : "New recurring rule",
    subtitle: account.name,
    control: h("div.stack",
      field("Label", label),
      field("Amount each time", amount),
      field("How often", frequency),
      field("Day of month", day, { hint: "A 31 lands on the last day in shorter months." }),
      field("Which part?", part),
      field("Starts", start),
      field("Ends", end, { hint: "Leave empty to run indefinitely." }),
      h("label.rowline", active, h("span", { text: "Active" })),
      !editing && h("label.rowline", backfill,
        h("span", { text: "Post every month from the start date" })),
      !editing && h("div.field__hint", {
        text: "Off by default — a new rule shouldn't quietly invent a year of deposits you never made.",
      }),
    ),
    parse: () => {
      const amount_minor = parseMoney(amount.input.value);
      if (!amount_minor || amount_minor <= 0) throw new Error("Enter the deposit amount");
      const dayNum = parseNumber(day.value);
      if (!dayNum || dayNum < 1 || dayNum > 31) throw new Error("Day of month must be 1–31");
      return {
        account_id: accountId,
        label: label.value.trim() || null,
        amount_minor,
        frequency: frequency.value,
        day_of_month: dayNum,
        contribution_part: part.value || null,
        start_date: start.value,
        end_date: end.value || null,
        is_active: active.checked,
        backfill: backfill.checked,
      };
    },
    onSave: async (body) => {
      if (editing) {
        await api.recurring.update(rule.id, body);
        toast("Rule saved");
      } else {
        const result = await api.recurring.create(body);
        toast(result.generated?.created
          ? `Rule added — posted ${result.generated.created} deposits`
          : "Rule added");
      }
      await reload();
      refresh();
    },
  });
}

// ── settings tab ─────────────────────────────────────────────────────────────

async function settingsTab(id, account, holdings, summary, currency, reload) {
  const rows = [
    ["Name", account.name],
    ["Category", categoryFull(account.category)],
    ["Valued by", VALUATION_MODE[account.valuation_mode].label],
    ["Funding", FUNDING_MODE[account.funding_mode].label],
    ["Currency", account.currency],
    ["Institution", account.institution || "—"],
    ["Fee on balance", account.mgmt_fee_balance_pct != null ? `${account.mgmt_fee_balance_pct}% / year` : "Not set"],
    ["Fee on deposit", account.mgmt_fee_deposit_pct != null ? `${account.mgmt_fee_deposit_pct}%` : "Not set"],
  ];

  const wrap = h("div",
    ...rows.map(([k, v]) => h("div.setting",
      h("div.setting__text", h("div.setting__title", { text: k })),
      h("div.muted", { text: v }),
    )),

    h("div.setting",
      h("div.setting__text",
        h("div.setting__title", { text: account.is_active ? "Active" : "Closed" }),
        h("div.setting__sub", {
          text: account.is_active
            ? "Counted in dashboard totals."
            : "Hidden from totals, but its history is kept.",
        }),
      ),
      h("button.btn.btn--sm", {
        type: "button",
        onclick: async () => {
          await api.accounts.update(id, { is_active: !account.is_active });
          toast(account.is_active ? "Account closed" : "Account reopened");
          refresh();
        },
      }, account.is_active ? "Close" : "Reopen"),
    ),

    h("div", { style: { padding: "var(--sp-4)", display: "grid", gap: "var(--sp-2)" } },
      h("button.btn.btn--primary.btn--block", {
        type: "button",
        onclick: () => openAccountForm({ account, onSaved: () => refresh() }),
      }, iconEl("pencil"), "Edit account"),

      account.valuation_mode === "market" && h("button.btn.btn--block", {
        type: "button", onclick: () => openHoldingForm(id, null, () => refresh()),
      }, iconEl("plus"), "Add holding"),

      h("button.btn.btn--danger.btn--block", {
        type: "button",
        onclick: () => confirmDeleteAccount(id, account),
      }, iconEl("trash"), "Delete account"),
    ),
  );

  return wrap;
}

/**
 * The one place a confirm is warranted: deleting an account takes its whole
 * history with it, and undo would have to rebuild hundreds of rows. Everything
 * cheaper to undo than to confirm uses the undo toast instead.
 */
function confirmDeleteAccount(id, account) {
  openSheet({
    title: `Delete ${account.name}?`,
    build: () => h("div.stack",
      h("p", { text: "This removes the account and everything filed under it — transactions, prices, balances, recurring rules and RSU grants." }),
      h("p.muted", { text: "This one can't be undone from a toast. Export a backup from Settings first if you want a way back." }),
    ),
    footer: (close) => frag(
      h("button.btn", { type: "button", onclick: () => close() }, "Keep it"),
      h("button.btn.btn--danger", {
        type: "button",
        onclick: async () => {
          try {
            const result = await api.accounts.remove(id);
            close();
            toast(`${account.name} deleted (${result.cascaded.transactions} transactions)`);
            location.hash = "#/accounts";
          } catch (err) { errorToast(err); }
        },
      }, "Delete everything"),
    ),
  });
}
