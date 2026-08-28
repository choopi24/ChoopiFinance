/**
 * The quick-add sheet — the control this app lives or dies by.
 *
 * Design rules, in priority order:
 *   1. THREE TAPS. + → what kind → Save. Everything else must already be right.
 *   2. The account picker defaults to whatever you used last.
 *   3. The date defaults to today, with one-tap shortcuts for the two dates
 *      that actually come up: yesterday, and last month-end (how every pension
 *      and hishtalmut statement is dated).
 *   4. The keyboard is the decimal pad, the currency symbol is already there,
 *      and the amount field has focus with its contents selected.
 *   5. "Save & add another" keeps the sheet open with the account and date
 *      intact, because entering month-end balances is a batch job.
 */

import { api } from "./api.js";
import { state, rememberAccount } from "./state.js";
import {
  h, frag, field, moneyInput, textInput, dateInput, select, openSheet,
  toast, errorToast, iconEl, emptyState,
} from "./ui.js";
import { icons } from "./icons.js";
import { symbolOf, parseMoney, parseNumber, todayIso, shiftDays, lastMonthEnd, dateLabel } from "./fmt.js";
import { categoryFull, CONTRIBUTION_PART, FEE_KIND } from "./labels.js";

/** Categories where a deposit can carry an employee/employer/severance split. */
const SPLIT_CATEGORIES = new Set(["keren_hishtalmut", "pension", "gemel_lehashkaa"]);

/**
 * The date row: a native date input plus the three shortcuts worth a tap.
 * Returns the row element with a `.value` getter.
 */
function dateRow(initial = todayIso()) {
  const input = dateInput({ value: initial, name: "date" });

  const shortcuts = [
    { label: "Today", value: () => todayIso() },
    { label: "Yesterday", value: () => shiftDays(todayIso(), -1) },
    { label: "Last month-end", value: () => lastMonthEnd() },
  ];

  const buttons = shortcuts.map(s => h("button.quickdate", {
    type: "button",
    onclick: () => { input.value = s.value(); syncPressed(); },
  }, s.label));

  function syncPressed() {
    buttons.forEach((b, i) => b.setAttribute("aria-pressed", input.value === shortcuts[i].value()));
  }
  input.addEventListener("change", syncPressed);
  syncPressed();

  const row = h("div.stack.stack--tight", input, h("div.quickdates", ...buttons));
  Object.defineProperty(row, "value", { get: () => input.value });
  row.input = input;
  return row;
}

/** Account <select>, grouped so the Israeli products don't hide among tickers. */
function accountSelect(accounts, { value, onchange } = {}) {
  const el = h("select.select", { name: "account_id", onchange });
  const groups = new Map();
  for (const a of accounts) {
    if (!groups.has(a.category)) groups.set(a.category, []);
    groups.get(a.category).push(a);
  }
  for (const [category, list] of groups) {
    const group = h("optgroup", { label: categoryFull(category) });
    for (const a of list) {
      group.append(h("option", {
        value: a.account_id ?? a.id,
        selected: String(a.account_id ?? a.id) === String(value),
      }, a.name));
    }
    el.append(group);
  }
  return el;
}

/** Pick the account to preselect: last used if it's still in the list. */
function preferredAccount(accounts) {
  const last = accounts.find(a => (a.account_id ?? a.id) === state.lastAccountId);
  return last ?? accounts[0] ?? null;
}

// ── the menu ─────────────────────────────────────────────────────────────────

const ACTIONS = [
  { key: "deposit", icon: "deposit", title: "Add deposit", sub: "Money you put in" },
  { key: "price",   icon: "price",   title: "Update price", sub: "A stock, ETF or coin" },
  { key: "balance", icon: "balance", title: "Update balance", sub: "Pension, hishtalmut, gemel" },
  { key: "fee",     icon: "fee",     title: "Add fee", sub: "Management or trading" },
  { key: "fx",      icon: "repeat",  title: "Add exchange rate", sub: "USD → ILS" },
];

/**
 * Open the quick-add flow. `initial` jumps straight past the menu — that is
 * what makes the "needs attention" cards one tap from being fixed.
 */
export function openQuickAdd({ onDone, initial = null, accountId = null, holdingId = null } = {}) {
  if (initial) return openForm(initial, { onDone, accountId, holdingId });

  return openSheet({
    title: "Add",
    build: (close) => h("div.actionlist",
      ...ACTIONS.map(a => h("button.action", {
        type: "button",
        onclick: () => { close(); openForm(a.key, { onDone, accountId }); },
      },
        h("div.action__icon", { html: icons[a.icon] }),
        h("div.action__text",
          h("div.action__title", { text: a.title }),
          h("div.action__sub", { text: a.sub }),
        ),
        h("span.faint", { html: icons.chevron }),
      )),
    ),
  });
}

// ── the forms ────────────────────────────────────────────────────────────────

const FORMS = {
  deposit: depositForm,
  price: priceForm,
  balance: balanceForm,
  fee: feeForm,
  fx: fxForm,
};

async function openForm(kind, options) {
  const build = FORMS[kind];
  if (!build) return;

  // The sheet opens immediately with a placeholder so the tap feels instant,
  // then fills in once the account list arrives.
  const sheet = openSheet({
    title: ACTIONS.find(a => a.key === kind)?.title ?? "Add",
    build: () => h("div.stack", h("div.skel.skel-block"), h("div.skel.skel-line")),
  });

  try {
    const view = await build(options, sheet.close);
    sheet.sheet.querySelector(".sheet__title").textContent = view.title;
    const body = sheet.body;
    body.replaceChildren(view.body);
    if (view.footer) {
      const foot = h("div.sheet__foot", view.footer);
      sheet.sheet.append(foot);
    }
    view.mounted?.();
  } catch (err) {
    sheet.close();
    errorToast(err);
  }
}

/** Save / Save & add another — the pair every form ends with. */
function saveFooter({ onSave, onSaveAnother, close, saveLabel = "Save" }) {
  const another = h("button.btn", { type: "button" }, "Save & add another");
  const save = h("button.btn.btn--primary", { type: "button" }, saveLabel);

  const run = async (btn, after) => {
    save.disabled = another.disabled = true;
    try {
      await onSave();
      after();
    } catch (err) {
      errorToast(err);
    } finally {
      save.disabled = another.disabled = false;
    }
  };

  another.onclick = () => run(another, () => onSaveAnother());
  save.onclick = () => run(save, () => close());
  return frag(another, save);
}

// ── deposit ──────────────────────────────────────────────────────────────────

async function depositForm({ onDone, accountId }, close) {
  const { accounts } = await api.accounts.list({ currency: state.currency });
  if (!accounts.length) return noAccounts(close);

  const chosen = accounts.find(a => a.account_id === accountId) ?? preferredAccount(accounts);
  let account = chosen;

  const amount = moneyInput({ symbol: symbolOf(account.currency), suffix: account.currency });
  const dates = dateRow();
  const note = textInput({ name: "note", placeholder: "Optional note" });

  const partField = field("Which part?", select(
    [{ value: "", label: "Not split" },
     ...Object.entries(CONTRIBUTION_PART).map(([value, label]) => ({ value, label }))],
    { name: "contribution_part" },
  ), { hint: "Pension and hishtalmut deposits arrive in employee, employer and severance slices." });

  const picker = accountSelect(accounts, {
    value: account.account_id,
    onchange: (e) => {
      account = accounts.find(a => String(a.account_id) === e.target.value);
      amount.querySelector(".money__prefix").textContent = symbolOf(account.currency);
      amount.querySelector(".money__suffix").textContent = account.currency;
      partField.hidden = !SPLIT_CATEGORIES.has(account.category);
    },
  });
  partField.hidden = !SPLIT_CATEGORIES.has(account.category);

  const body = h("div.stack",
    field("Account", picker),
    field("Amount", amount),
    field("Date", dates),
    partField,
    field("Note", note),
  );

  const submit = async () => {
    const amount_minor = parseMoney(amount.input.value);
    if (!amount_minor) throw new Error("Enter an amount");
    const part = partField.querySelector("select").value;
    await api.transactions.create({
      account_id: account.account_id,
      type: "deposit",
      date: dates.value,
      amount_minor,
      contribution_part: part || null,
      note: note.value || null,
    });
    rememberAccount(account.account_id);
    toast(`Deposit added to ${account.name}`);
    onDone?.();
  };

  return {
    title: "Add deposit",
    body,
    footer: saveFooter({
      close,
      onSave: submit,
      onSaveAnother: () => { amount.input.value = ""; note.value = ""; amount.input.focus(); },
    }),
    mounted: () => amount.input.focus(),
  };
}

// ── price ────────────────────────────────────────────────────────────────────

async function priceForm({ onDone, holdingId, accountId }, close) {
  const { holdings } = await api.holdings.list();
  if (!holdings.length) {
    return {
      title: "Update price",
      body: emptyState({
        title: "No market holdings yet",
        hint: "Prices belong to a holding — add a stock, ETF or crypto account first, then a symbol inside it.",
        actionLabel: "Go to accounts",
        onAction: () => { close(); location.hash = "#/accounts"; },
      }),
    };
  }

  // Preference order: the exact holding asked for, then any holding in the
  // account asked for (a "Kraken price is stale" card must land on Kraken),
  // then the last account you touched, then whatever is first.
  let holding = holdings.find(x => x.id === holdingId)
    ?? holdings.find(x => x.account_id === accountId)
    ?? holdings.find(x => x.account_id === state.lastAccountId)
    ?? holdings[0];

  const amount = moneyInput({
    symbol: symbolOf(holding.currency),
    suffix: `per unit · ${holding.currency}`,
  });
  const dates = dateRow();
  const last = h("div.field__hint");

  function syncLast() {
    last.textContent = holding.last_price_date
      ? `Last: ${symbolOf(holding.currency)}${(holding.last_price_minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} on ${dateLabel(holding.last_price_date, { year: true })}`
      : "No price entered for this holding yet.";
  }
  syncLast();

  const picker = h("select.select", {
    name: "holding_id",
    onchange: (e) => {
      holding = holdings.find(x => String(x.id) === e.target.value);
      amount.querySelector(".money__prefix").textContent = symbolOf(holding.currency);
      amount.querySelector(".money__suffix").textContent = `per unit · ${holding.currency}`;
      syncLast();
    },
  });
  const byAccount = new Map();
  for (const x of holdings) {
    if (!byAccount.has(x.account_name)) byAccount.set(x.account_name, []);
    byAccount.get(x.account_name).push(x);
  }
  for (const [name, list] of byAccount) {
    const group = h("optgroup", { label: name });
    for (const x of list) {
      group.append(h("option", { value: x.id, selected: x.id === holding.id },
        x.display_name ? `${x.symbol} — ${x.display_name}` : x.symbol));
    }
    picker.append(group);
  }

  const body = h("div.stack",
    field("Holding", picker),
    field("Price", amount, { hint: " " }),
    last,
    field("Date", dates),
  );

  const submit = async () => {
    const price_minor = parseMoney(amount.input.value);
    if (price_minor == null || price_minor < 0) throw new Error("Enter a price");
    await api.prices.create({ holding_id: holding.id, date: dates.value, price_minor });
    holding.last_price_minor = price_minor;
    holding.last_price_date = dates.value;
    rememberAccount(holding.account_id);
    toast(`${holding.symbol} priced at ${symbolOf(holding.currency)}${(price_minor / 100).toFixed(2)}`);
    onDone?.();
  };

  return {
    title: "Update price",
    body,
    footer: saveFooter({
      close,
      onSave: submit,
      onSaveAnother: () => { syncLast(); amount.input.value = ""; amount.input.focus(); },
    }),
    mounted: () => amount.input.focus(),
  };
}

// ── balance ──────────────────────────────────────────────────────────────────

async function balanceForm({ onDone, accountId }, close) {
  const { accounts } = await api.accounts.list({ currency: state.currency });
  const balanceAccounts = accounts.filter(a => a.valuation_mode === "balance");

  if (!balanceAccounts.length) {
    return {
      title: "Update balance",
      body: emptyState({
        title: "No balance-tracked accounts",
        hint: "Keren hishtalmut, pension and gemel accounts are valued from the balance on your statement. Add one to record balances here.",
        actionLabel: "Go to accounts",
        onAction: () => { close(); location.hash = "#/accounts"; },
      }),
    };
  }

  let account = balanceAccounts.find(a => a.account_id === accountId)
    ?? preferredAccount(balanceAccounts);

  // Statements are dated to month-end, so that is the sensible default here —
  // the one place where today is the wrong guess.
  const amount = moneyInput({ symbol: symbolOf(account.currency), suffix: account.currency });
  const dates = dateRow(lastMonthEnd());
  const last = h("div.field__hint");

  function syncLast() {
    last.textContent = account.last_data_date
      ? `Last balance: ${symbolOf(account.currency)}${(account.value_minor / 100).toLocaleString("en-US")} on ${dateLabel(account.last_data_date, { year: true })}`
      : "No balance recorded for this account yet.";
  }
  syncLast();

  const picker = accountSelect(balanceAccounts, {
    value: account.account_id,
    onchange: (e) => {
      account = balanceAccounts.find(a => String(a.account_id) === e.target.value);
      amount.querySelector(".money__prefix").textContent = symbolOf(account.currency);
      amount.querySelector(".money__suffix").textContent = account.currency;
      syncLast();
    },
  });

  const body = h("div.stack",
    field("Account", picker),
    field("Balance on the statement", amount),
    last,
    field("Date", dates, { hint: "Statements are usually dated to the end of the month." }),
  );

  const submit = async () => {
    const balance_minor = parseMoney(amount.input.value);
    if (balance_minor == null || balance_minor < 0) throw new Error("Enter the balance");
    await api.valuations.create({
      account_id: account.account_id, date: dates.value, balance_minor,
    });
    rememberAccount(account.account_id);
    toast(`${account.name} balance updated`);
    onDone?.();
  };

  return {
    title: "Update balance",
    body,
    footer: saveFooter({
      close,
      onSave: submit,
      onSaveAnother: () => { amount.input.value = ""; amount.input.focus(); },
    }),
    mounted: () => amount.input.focus(),
  };
}

// ── fee ──────────────────────────────────────────────────────────────────────

async function feeForm({ onDone, accountId }, close) {
  const { accounts } = await api.accounts.list({ currency: state.currency });
  if (!accounts.length) return noAccounts(close);

  let account = accounts.find(a => a.account_id === accountId) ?? preferredAccount(accounts);

  const amount = moneyInput({ symbol: symbolOf(account.currency), suffix: account.currency });
  const dates = dateRow(lastMonthEnd());
  const kind = select(
    Object.entries(FEE_KIND).map(([value, label]) => ({ value, label })),
    { name: "fee_kind", value: "management_balance" },
  );

  const picker = accountSelect(accounts, {
    value: account.account_id,
    onchange: (e) => {
      account = accounts.find(a => String(a.account_id) === e.target.value);
      amount.querySelector(".money__prefix").textContent = symbolOf(account.currency);
      amount.querySelector(".money__suffix").textContent = account.currency;
    },
  });

  const body = h("div.stack",
    field("Account", picker),
    field("Fee charged", amount, { hint: "Enter it as a positive number — it's recorded as money out." }),
    field("What kind?", kind),
    field("Date", dates),
  );

  const submit = async () => {
    const amount_minor = parseMoney(amount.input.value);
    if (!amount_minor) throw new Error("Enter the fee amount");
    await api.transactions.create({
      account_id: account.account_id,
      type: "fee",
      fee_kind: kind.value,
      date: dates.value,
      amount_minor: Math.abs(amount_minor),
    });
    rememberAccount(account.account_id);
    toast(`Fee recorded against ${account.name}`);
    onDone?.();
  };

  return {
    title: "Add fee",
    body,
    footer: saveFooter({
      close,
      onSave: submit,
      onSaveAnother: () => { amount.input.value = ""; amount.input.focus(); },
    }),
    mounted: () => amount.input.focus(),
  };
}

// ── FX ───────────────────────────────────────────────────────────────────────

async function fxForm({ onDone }, close) {
  const rate = h("input.money__input", {
    type: "text", inputmode: "decimal", placeholder: "3.72", name: "rate",
    onfocus: (e) => e.target.select(),
  });
  const wrap = h("div.money", h("span.money__prefix", { text: "₪" }), rate,
    h("span.money__suffix", { text: "per $1" }));
  const dates = dateRow();

  const body = h("div.stack",
    field("USD → ILS rate", wrap, {
      hint: "How many shekels one dollar buys. Used for every total that mixes currencies.",
    }),
    field("Date", dates, {
      hint: "The most recent rate on or before a date is the one used for that date.",
    }),
  );

  const submit = async () => {
    const value = parseNumber(rate.value);
    if (!value || value <= 0) throw new Error("Enter a rate, e.g. 3.72");
    await api.fx.create({
      date: dates.value, base_currency: "USD", quote_currency: "ILS", rate: value,
    });
    toast(`Rate saved: $1 = ₪${value}`);
    onDone?.();
  };

  return {
    title: "Add exchange rate",
    body,
    footer: saveFooter({
      close, onSave: submit,
      onSaveAnother: () => { rate.value = ""; rate.focus(); },
    }),
    mounted: () => rate.focus(),
  };
}

function noAccounts(close) {
  return {
    title: "No accounts yet",
    body: emptyState({
      title: "Add an account first",
      hint: "Everything here hangs off an account — a brokerage, a pension, a keren hishtalmut.",
      actionLabel: "Go to accounts",
      onAction: () => { close(); location.hash = "#/accounts"; },
    }),
  };
}
