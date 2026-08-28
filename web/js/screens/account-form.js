/**
 * The create/edit-account sheet, shared by the accounts list and the account's
 * own Settings tab.
 *
 * `valuation_mode` is the field everything else hangs off, so it is presented
 * first and in plain language: a thing you look up a price for, or a thing you
 * read a balance off a statement.
 */

import { api } from "../api.js";
import {
  h, field, textInput, numberInput, select, openSheet, toast, errorToast, frag,
} from "../ui.js";
import { parseNumber } from "../fmt.js";
import { CATEGORY, categoryFull, VALUATION_MODE, FUNDING_MODE } from "../labels.js";

/** The valuation mode each category almost always uses. */
const DEFAULT_MODE = {
  stock: "market", etf: "market", crypto: "market", rsu: "market", cash: "balance",
  keren_hishtalmut: "balance", pension: "balance", gemel_lehashkaa: "balance",
};

export function openAccountForm({ account = null, onSaved } = {}) {
  const editing = Boolean(account);

  const name = textInput({ name: "name", value: account?.name ?? "", placeholder: "e.g. Pension — Menora" });
  const institution = textInput({
    name: "institution", value: account?.institution ?? "", placeholder: "Optional — who holds it",
  });

  const category = select(
    Object.keys(CATEGORY).map(value => ({ value, label: categoryFull(value) })),
    { name: "category", value: account?.category ?? "keren_hishtalmut" },
  );

  const valuation = select(
    Object.entries(VALUATION_MODE).map(([value, v]) => ({ value, label: v.label })),
    { name: "valuation_mode", value: account?.valuation_mode ?? "balance" },
  );
  const valuationHint = h("div.field__hint");

  const funding = select(
    Object.entries(FUNDING_MODE).map(([value, v]) => ({ value, label: v.label })),
    { name: "funding_mode", value: account?.funding_mode ?? "manual" },
  );
  const fundingHint = h("div.field__hint");

  const currency = select(
    [{ value: "ILS", label: "₪ Shekel (ILS)" }, { value: "USD", label: "$ Dollar (USD)" }],
    { name: "currency", value: account?.currency ?? "ILS" },
  );

  const feeBalance = numberInput({
    name: "mgmt_fee_balance_pct", placeholder: "0.55",
    value: account?.mgmt_fee_balance_pct ?? "",
  });
  const feeDeposit = numberInput({
    name: "mgmt_fee_deposit_pct", placeholder: "1.5",
    value: account?.mgmt_fee_deposit_pct ?? "",
  });

  const syncHints = () => {
    valuationHint.textContent = VALUATION_MODE[valuation.value].hint;
    fundingHint.textContent = FUNDING_MODE[funding.value].hint;
  };
  valuation.onchange = syncHints;
  funding.onchange = syncHints;
  // Choosing a category on a new account picks the mode that goes with it.
  category.onchange = () => {
    if (!editing) { valuation.value = DEFAULT_MODE[category.value] ?? "balance"; syncHints(); }
  };
  syncHints();

  return openSheet({
    title: editing ? "Edit account" : "New account",
    build: () => h("div.stack",
      field("Name", name),
      field("Category", category),
      field("How is it valued?", valuation), valuationHint,
      field("How does money arrive?", funding), fundingHint,
      field("Currency", currency, {
        hint: "Totals convert to your display currency using the rates you enter.",
      }),
      field("Institution", institution),
      field("Management fee on balance (%/year)", feeBalance, {
        hint: "דמי ניהול מצבירה — used to estimate fees alongside the ones you record.",
      }),
      field("Management fee on deposit (%)", feeDeposit, {
        hint: "דמי ניהול מהפקדה — taken off each deposit as it goes in.",
      }),
    ),
    footer: (close) => h("button.btn.btn--primary", {
      type: "button",
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const body = {
            name: name.value.trim(),
            institution: institution.value.trim() || null,
            category: category.value,
            valuation_mode: valuation.value,
            funding_mode: funding.value,
            currency: currency.value,
            mgmt_fee_balance_pct: parseNumber(feeBalance.value),
            mgmt_fee_deposit_pct: parseNumber(feeDeposit.value),
          };
          if (!body.name) throw new Error("Give the account a name");

          const saved = editing
            ? await api.accounts.update(account.id ?? account.account_id, body)
            : await api.accounts.create(body);

          toast(editing ? "Account saved" : `${body.name} added`);
          close();
          onSaved?.(saved);
        } catch (err) {
          errorToast(err);
          btn.disabled = false;
        }
      },
    }, editing ? "Save changes" : "Create account"),
  });
}
