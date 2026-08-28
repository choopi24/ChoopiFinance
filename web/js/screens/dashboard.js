/**
 * The dashboard: one screen that answers "what do I have, how much of it did I
 * put in, and how much did it earn" without a single tap.
 */

import { api } from "../api.js";
import { state, setCurrency, setRange, setAllocationBy } from "../state.js";
import {
  h, frag, segmented, iconEl, toast, errorToast, emptyState,
} from "../ui.js";
import { money, moneyCompact, pct, dateLabel, agoLabel } from "../fmt.js";
import { labelFor, colorVarFor, cssVar, categoryShort } from "../labels.js";
import {
  stackedAreaChart, donutChart, feesBarChart, legend,
} from "../charts.js";
import { openQuickAdd } from "../quickadd.js";
import { refresh } from "../app.js";

const RANGES = [
  { value: "3M", label: "3M" },
  { value: "1Y", label: "1Y" },
  { value: "YTD", label: "YTD" },
  { value: "ALL", label: "All" },
];

export async function dashboardScreen() {
  const currency = state.currency;
  const range = state.range;
  const by = state.allocationBy;

  // One round of parallel requests — the phone is often on a slow link, and
  // five sequential fetches is a visibly slower dashboard.
  const [summary, series, allocation, attention, fees] = await Promise.all([
    api.portfolio.summary({ currency }),
    api.portfolio.series({ currency, range }),
    api.portfolio.allocation({ currency, by }),
    api.portfolio.attention({ currency }),
    api.portfolio.feesMonthly({ currency, months: 12 }),
  ]);

  const empty = summary.accounts.length === 0;
  const node = h("div.stack");

  node.append(heroCard(summary, currency));

  if (empty) {
    node.append(h("div.card", emptyState({
      title: "Nothing tracked yet",
      hint: "Add your first account — a keren hishtalmut, a pension, or a brokerage — and this screen fills in.",
      actionLabel: "Add an account",
      onAction: () => { location.hash = "#/accounts"; },
    })));
    return { title: "Dashboard", node };
  }

  if (attention.items.length) node.append(attentionStrip(attention.items));

  const chartsRow = h("div.grid-3");
  chartsRow.append(mainChartCard(series, summary, currency, range));
  chartsRow.append(h("div.stack",
    allocationCard(allocation, by, currency),
    feesCard(fees, summary, currency),
  ));
  node.append(chartsRow);

  return { title: "Dashboard", node };
}

// ── hero + KPIs ──────────────────────────────────────────────────────────────

function heroCard(summary, currency) {
  const earningsPositive = summary.net_earnings_minor >= 0;

  return h("div.card.stack",
    h("div.rowline",
      h("div.hero__label", { text: "Total value" }),
      h("span.spacer"),
      segmented(
        [{ value: "ILS", label: "₪ ILS" }, { value: "USD", label: "$ USD" }],
        currency,
        async (next) => {
          setCurrency(next);
          try { await api.settings.update({ display_currency: next }); } catch { /* local still applies */ }
          refresh();
        },
      ),
    ),

    h("div.hero__row",
      h("div.hero__value", { text: money(summary.value_minor, currency, { decimals: false }) }),
    ),

    h("div.kpis",
      kpi("My money", money(summary.net_principal_minor, currency, { decimals: false }),
        "Net principal"),
      kpi("Earnings",
        money(summary.net_earnings_minor, currency, { decimals: false, sign: true }),
        pct(summary.simple_return_pct),
        earningsPositive ? "pos" : "neg"),
      kpi("Fees paid", money(summary.fees_paid_minor, currency, { decimals: false }),
        summary.gross_earnings_minor
          ? `${((summary.fees_paid_minor / summary.gross_earnings_minor) * 100).toFixed(1)}% of growth`
          : "—"),
    ),

    ratioBar(summary.net_principal_minor, summary.net_earnings_minor),

    // Accounts with no price or balance yet are left out of the totals rather
    // than counted as a total loss — say so, or the total is quietly incomplete.
    summary.excluded_accounts?.length
      ? h("div.notice.notice--warn",
          h("span.notice__icon", iconEl("alert")),
          h("div",
            h("strong", { text: `${summary.excluded_accounts.length} account${summary.excluded_accounts.length === 1 ? "" : "s"} not in this total. ` }),
            `${summary.excluded_accounts.map(a => a.name).join(", ")} — ` +
            `${money(summary.excluded_accounts.reduce((s, a) => s + a.net_principal_minor, 0), currency, { decimals: false })} ` +
            "paid in, but no price or balance entered yet.",
          ),
        )
      : null,

    h("div.faint", {
      text: `As of ${dateLabel(summary.as_of, { year: true })}`,
      style: { fontSize: "var(--text-xs)" },
    }),
  );
}

function kpi(label, value, sub, tone = "") {
  return h("div.kpi",
    h("div.kpi__label", { text: label }),
    h(`div.kpi__value${tone ? `.${tone}` : ""}`, { text: value }),
    h("div.kpi__sub", { text: sub }),
  );
}

/**
 * The principal/earnings split as one bar. It answers the app's core question
 * pre-attentively — you see the proportion before you read a single number.
 */
function ratioBar(principal, earnings) {
  const total = Math.max(principal + Math.max(earnings, 0), 1);
  const pPct = (principal / total) * 100;

  return h("div",
    h("div.ratio",
      h("div.ratio__principal", { style: { width: `${Math.max(0, Math.min(100, pPct))}%` } }),
      earnings >= 0
        ? h("div.ratio__earnings", { style: { flex: "1" } })
        : h("div.ratio__loss", { style: { flex: "1" } }),
    ),
    h("div.legend",
      h("div.legend__item",
        h("span.legend__swatch", { style: { background: cssVar("--accent") } }), "My money"),
      h("div.legend__item",
        h("span.legend__swatch", {
          style: { background: cssVar(earnings >= 0 ? "--emerald" : "--rose") },
        }), earnings >= 0 ? "Earnings" : "Loss"),
    ),
  );
}

// ── needs attention ──────────────────────────────────────────────────────────

/**
 * Cards that scroll horizontally, each one tap from the thing that fixes it.
 * Nothing here is an error — with no price feed, a stale number is simply a
 * number only you can refresh.
 */
function attentionStrip(items) {
  const cardFor = (item) => {
    const cta = {
      update_balance: "Update balance",
      update_price: "Update price",
      add_fx: "Add rate",
      open_account: "Open account",
    }[item.action];

    return h(`button.attn${item.severity === "info" ? ".attn--info" : ""}`, {
      type: "button",
      onclick: () => {
        if (item.action === "open_account") { location.hash = `#/accounts/${item.account_id}`; return; }
        const kind = { update_balance: "balance", update_price: "price", add_fx: "fx" }[item.action];
        openQuickAdd({
          initial: kind,
          accountId: item.account_id ?? null,
          holdingId: item.holding_id ?? null,
          onDone: () => refresh(),
        });
      },
    },
      h("div.rowline",
        h("span", { html: item.severity === "warn" ? iconEl("alert").innerHTML : iconEl("repeat").innerHTML,
          style: { display: "inline-flex", color: item.severity === "warn" ? "var(--amber)" : "var(--text-faint)" } }),
        h("div.attn__title", { text: item.title }),
      ),
      h("div.attn__detail", { text: item.detail }),
      h("div.attn__cta", { text: `${cta} →` }),
    );
  };

  return h("div.card.stack--tight",
    h("div.card__head",
      h("div.card__title", { text: `Needs attention · ${items.length}` }),
    ),
    h("div.attention", ...items.map(cardFor)),
  );
}

// ── main chart ───────────────────────────────────────────────────────────────

function mainChartCard(series, summary, currency, range) {
  const chartBox = h("div.chart.chart--tall");

  const card = h("div.card.stack",
    h("div.card__head",
      h("div.card__title", { text: "My money vs earnings" }),
    ),
    segmented(RANGES, range, (next) => { setRange(next); refresh(); }, { full: true }),
    chartBox,
    legend([
      { color: cssVar("--accent"), label: "My money",
        value: moneyCompact(summary.net_principal_minor, currency) },
      { color: cssVar(summary.net_earnings_minor >= 0 ? "--emerald" : "--rose"),
        label: summary.net_earnings_minor >= 0 ? "Earnings" : "Loss",
        value: moneyCompact(summary.net_earnings_minor, currency) },
    ]),
    h("div.faint", {
      text: "Tap the chart to see any date's breakdown.",
      style: { fontSize: "var(--text-sm)" },
    }),
  );

  // The canvas needs a laid-out parent before Chart.js measures it.
  requestAnimationFrame(() => stackedAreaChart(chartBox, { points: series.points, currency }));
  return card;
}

// ── allocation ───────────────────────────────────────────────────────────────

function allocationCard(allocation, by, currency) {
  const chartBox = h("div.chart.chart--donut");

  const entries = allocation.slices.map(s => ({
    color: cssVar(colorVarFor(s.key, by)),
    label: `${labelFor(s.key, by)} · ${s.share_pct.toFixed(0)}%`,
    value: moneyCompact(s.value_minor, currency),
  }));

  const card = h("div.card.stack",
    h("div.card__head", h("div.card__title", { text: "Allocation" })),
    segmented(
      [{ value: "category", label: "By category" }, { value: "asset_class", label: "By asset class" }],
      by,
      (next) => { setAllocationBy(next); refresh(); },
      { full: true },
    ),
    chartBox,
    allocation.slices.length ? legend(entries) : null,
  );

  requestAnimationFrame(() => donutChart(chartBox, {
    slices: allocation.slices, by, currency, total: allocation.total_minor,
  }));
  return card;
}

// ── fees ─────────────────────────────────────────────────────────────────────

function feesCard(fees, summary, currency) {
  const chartBox = h("div.chart");

  const card = h("div.card.stack",
    h("div.card__head",
      h("div.card__title", { text: "Fees paid" }),
      h("span.badge", { text: `${money(summary.fees_paid_minor, currency, { decimals: false })} to date` }),
    ),
    chartBox,
    h("div.faint", {
      text: fees.window_total_minor
        ? `${money(fees.window_total_minor, currency, { decimals: false })} charged in the last 12 months.`
        : "Nothing charged in the last 12 months.",
      style: { fontSize: "var(--text-sm)" },
    }),
  );

  requestAnimationFrame(() => feesBarChart(chartBox, { months: fees.months, currency }));
  return card;
}
