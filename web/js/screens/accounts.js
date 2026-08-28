/**
 * The accounts list: one card per account, each showing the same decomposition
 * as the dashboard, scoped down.
 *
 * Sort and filter state lives in the URL hash query rather than in a module
 * variable, so a filtered view survives a refresh and can be bookmarked on the
 * phone's home screen.
 */

import { api } from "../api.js";
import { state } from "../state.js";
import { h, segmented, select, field, iconEl, emptyState } from "../ui.js";
import { money, pct, agoLabel } from "../fmt.js";
import { CATEGORY, categoryEn, categoryHe, categoryShort, colorVarFor, cssVar, FUNDING_MODE } from "../labels.js";
import { openAccountForm } from "./account-form.js";
import { refresh } from "../app.js";

const SORTS = {
  value: { label: "Value", cmp: (a, b) => b.value_display_minor - a.value_display_minor },
  earnings: { label: "Earnings", cmp: (a, b) => b.net_earnings_display_minor - a.net_earnings_display_minor },
  return: { label: "Return %", cmp: (a, b) => (b.simple_return_pct ?? -1e9) - (a.simple_return_pct ?? -1e9) },
  name: { label: "Name", cmp: (a, b) => a.name.localeCompare(b.name) },
  updated: {
    label: "Last updated",
    // Never-updated accounts sort to the top: they are the ones needing work.
    cmp: (a, b) => String(a.last_data_date ?? "").localeCompare(String(b.last_data_date ?? "")),
  },
};

/** Read "?sort=value&category=all" out of the hash. */
function readQuery() {
  const raw = location.hash.split("?")[1] ?? "";
  const q = new URLSearchParams(raw);
  return {
    sort: SORTS[q.get("sort")] ? q.get("sort") : "value",
    category: q.get("category") ?? "all",
    funding: q.get("funding") ?? "all",
  };
}

function writeQuery(next) {
  const q = new URLSearchParams({ ...readQuery(), ...next });
  location.hash = `#/accounts?${q}`;
}

export async function accountsScreen() {
  const currency = state.currency;
  const query = readQuery();
  const { accounts } = await api.accounts.list({ currency, include_inactive: "true" });

  const visible = accounts
    .filter(a => query.category === "all" || a.category === query.category)
    .filter(a => query.funding === "all" || a.funding_mode === query.funding)
    .sort(SORTS[query.sort].cmp);

  const node = h("div.stack");

  if (!accounts.length) {
    node.append(h("div.card", emptyState({
      title: "No accounts yet",
      hint: "Start with the ones that matter most — your keren hishtalmut and pension. You can add a brokerage later.",
      actionLabel: "Add an account",
      onAction: () => openAccountForm({ onSaved: () => refresh() }),
      icon: "wallet",
    })));
    return { title: "Accounts", node };
  }

  node.append(filterBar(accounts, query));

  if (!visible.length) {
    node.append(h("div.card", emptyState({
      title: "Nothing matches those filters",
      hint: "Try clearing the category or funding filter.",
      actionLabel: "Clear filters",
      onAction: () => writeQuery({ category: "all", funding: "all" }),
    })));
  } else {
    node.append(h("div.stack.stack--tight", ...visible.map(a => accountCard(a, currency))));
  }

  node.append(h("button.btn.btn--block", {
    type: "button",
    onclick: () => openAccountForm({ onSaved: () => refresh() }),
  }, iconEl("plus"), "New account"));

  const total = visible.reduce((s, a) => s + a.value_display_minor, 0);
  node.append(h("div.faint", {
    style: { fontSize: "var(--text-sm)", textAlign: "center" },
    text: `${visible.length} of ${accounts.length} accounts · ${money(total, currency, { decimals: false })}`,
  }));

  return { title: "Accounts", node };
}

function filterBar(accounts, query) {
  // Only offer categories that actually exist — an empty filter result is a
  // dead end you had no way of predicting.
  const present = [...new Set(accounts.map(a => a.category))];

  return h("div.card.stack.stack--tight",
    field("Sort by", segmented(
      Object.entries(SORTS).map(([value, s]) => ({ value, label: s.label })),
      query.sort,
      (value) => writeQuery({ sort: value }),
      { scroll: true },
    )),
    h("div.grid-2",
      field("Category", select(
        [{ value: "all", label: "All categories" },
         ...present.map(value => ({ value, label: CATEGORY[value] ? categoryEn(value) : value }))],
        { value: query.category, onchange: (e) => writeQuery({ category: e.target.value }) },
      )),
      field("Funding", select(
        [{ value: "all", label: "All funding modes" },
         ...Object.entries(FUNDING_MODE).map(([value, f]) => ({ value, label: f.label }))],
        { value: query.funding, onchange: (e) => writeQuery({ funding: e.target.value }) },
      )),
    ),
  );
}

export function categoryBadge(category) {
  const he = categoryHe(category);
  return h("span.badge",
    h("span.badge__dot", { style: { background: cssVar(colorVarFor(category)) } }),
    h("span", { text: categoryEn(category) }),
    he && h("span.badge--he", { text: he }),
  );
}

function accountCard(a, currency) {
  const up = a.net_earnings_display_minor >= 0;
  const stale = a.flags.includes("stale_data") || a.flags.includes("no_data");

  return h("button.acct", {
    type: "button",
    onclick: () => { location.hash = `#/accounts/${a.account_id}`; },
  },
    h("div.acct__top",
      h("div.acct__name", { text: a.name }),
      h("div.acct__value", { text: money(a.value_display_minor, currency, { decimals: false }) }),
    ),

    h("div.acct__meta",
      categoryBadge(a.category),
      a.funding_mode === "salary" && h("span.badge", { text: "Salary-funded" }),
      a.is_active === 0 && h("span.badge", { text: "Closed" }),
      h("span.badge", {
        style: stale ? { background: "var(--amber-soft)", color: "var(--amber)" } : {},
        text: a.last_data_date ? `Updated ${agoLabel(a.last_data_date)}` : "Never updated",
      }),
    ),

    h("div.acct__split",
      h("div",
        h("span", { text: "My money" }),
        h("span.num", { text: money(a.net_principal_display_minor, currency, { decimals: false }) }),
      ),
      h("div", { style: { textAlign: "right" } },
        h("span", { text: "Earnings" }),
        h("span.num", { class: up ? "pos" : "neg",
          text: `${money(a.net_earnings_display_minor, currency, { decimals: false, sign: true })}  ${pct(a.simple_return_pct)}` }),
      ),
    ),

    ratio(a.net_principal_display_minor, a.net_earnings_display_minor),
  );
}

function ratio(principal, earnings) {
  const total = Math.max(principal + Math.max(earnings, 0), 1);
  const pPct = Math.max(0, Math.min(100, (principal / total) * 100));
  return h("div.ratio",
    h("div.ratio__principal", { style: { width: `${pPct}%` } }),
    h(earnings >= 0 ? "div.ratio__earnings" : "div.ratio__loss", { style: { flex: "1" } }),
  );
}
