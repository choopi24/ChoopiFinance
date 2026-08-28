/**
 * DOM plumbing: element building, bottom sheets, undo toasts, form controls.
 *
 * No virtual DOM and no framework. Screens build real nodes and swap them in;
 * a personal tracker re-renders a card, not sixty thousand rows, so diffing
 * would buy nothing and cost a dependency.
 */

import { icons } from "./icons.js";

// ── element building ─────────────────────────────────────────────────────────

/**
 * h("div.card", { onclick }, child, child) — the tag accepts a CSS-ish
 * shorthand so the common case (a div with classes) is one string.
 */
export function h(spec, props, ...children) {
  const [tag, ...classes] = String(spec).split(".");
  const el = document.createElement(tag || "div");
  if (classes.length) el.className = classes.join(" ");

  // The props argument is optional. Anything that is plainly a child — a node,
  // a string, an array — shifts into the children list, so h("div", node) and
  // h("div", {}, node) both do the obvious thing.
  if (props instanceof Node || Array.isArray(props) ||
      typeof props === "string" || typeof props === "number") {
    children.unshift(props);
    props = null;
  }

  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = `${el.className} ${value}`.trim();
    else if (key === "html") el.innerHTML = value;
    else if (key === "text") el.textContent = value;
    else if (key === "style") Object.assign(el.style, value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value);
    } else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  }

  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === "") continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
};

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Replace a node's contents in one shot. */
export function render(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

export const iconEl = (name, cls = "") =>
  h("span", { class: cls, html: icons[name], style: { display: "inline-flex" } });

// ── toasts ───────────────────────────────────────────────────────────────────

const toastHost = () => document.getElementById("toasts");

/**
 * A toast, optionally carrying an undo.
 *
 * Destructive actions confirm AFTER the fact, not before: a modal "are you
 * sure?" makes you answer a question about a row you can already see, on a
 * phone, with your thumb over the buttons. Undo costs one tap and only when
 * you were actually wrong.
 */
export function toast(message, { undo = null, duration = 6000, variant = "" } = {}) {
  const host = toastHost();
  if (!host) return () => {};

  let timer = null;
  const el = h(`div.toast${variant ? `.toast--${variant}` : ""}`, { role: "status" },
    h("div.toast__msg", { text: message }),
    undo && h("button.toast__undo", {
      type: "button",
      onclick: async () => {
        clearTimeout(timer);
        el.remove();
        try {
          await undo();
        } catch (err) {
          toast(err.message || "Undo failed", { variant: "error" });
        }
      },
    }, "Undo"),
  );

  host.append(el);
  const dismiss = () => { clearTimeout(timer); el.remove(); };
  timer = setTimeout(dismiss, duration);
  return dismiss;
}

export const errorToast = (err) =>
  toast(err?.message || String(err), { variant: "error", duration: 7000 });

// ── bottom sheet ─────────────────────────────────────────────────────────────

const layerHost = () => document.getElementById("layers");

/**
 * A bottom sheet. Returns { close }.
 *
 * `build(close)` receives the closer so a Save button can dismiss itself. The
 * scrim closes on tap and on Escape; both are what a phone user expects, and
 * neither can lose typed data because nothing here saves implicitly.
 */
export function openSheet({ title, subtitle, build, footer, onClose, dismissible = true }) {
  const host = layerHost();
  const body = h("div.sheet__body");
  const foot = footer ? h("div.sheet__foot") : null;

  const sheet = h("div.sheet", { role: "dialog", "aria-modal": "true", "aria-label": title || "Dialog" },
    h("div.sheet__grip"),
    h("div.sheet__head",
      h("div",
        h("div.sheet__title", { text: title || "" }),
        subtitle && h("div.faint", { text: subtitle, style: { fontSize: "var(--text-sm)" } }),
      ),
      h("span.spacer"),
      dismissible && h("button.iconbtn", {
        type: "button", "aria-label": "Close", onclick: () => close(),
      }, iconEl("close")),
    ),
    body,
    foot,
  );

  const scrim = h("div.scrim", {
    onclick: (e) => { if (e.target === scrim && dismissible) close(); },
  }, sheet);

  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    scrim.remove();
    document.body.style.overflow = "";
    onClose?.(result);
  }
  function onKey(e) {
    if (e.key === "Escape" && dismissible) close();
  }

  append(body, [build(close)]);
  if (foot) append(foot, [footer(close)]);

  document.addEventListener("keydown", onKey);
  document.body.style.overflow = "hidden"; // stop the page scrolling behind
  host.append(scrim);

  // Focus the first real input so the keyboard is already up on a phone.
  requestAnimationFrame(() => {
    sheet.querySelector("input:not([type=hidden]), select, textarea")?.focus();
  });

  return { close, sheet, body };
}

// ── form controls ────────────────────────────────────────────────────────────

export function field(label, control, { hint, error } = {}) {
  return h("div.field",
    h("label.field__label", { text: label }),
    control,
    hint && h("div.field__hint", { text: hint }),
    error && h("div.field__error", { text: error }),
  );
}

/**
 * The money input: currency symbol baked into the control, decimal keypad on a
 * phone, and no spinner arrows to mis-tap.
 */
export function moneyInput({ symbol = "₪", value = "", suffix = "", name = "amount" } = {}) {
  const input = h("input.money__input", {
    type: "text",
    inputmode: "decimal",
    autocomplete: "off",
    enterkeyhint: "done",
    name,
    value,
    placeholder: "0.00",
    // Select-all on focus: correcting a figure is retyping it, not editing it.
    onfocus: (e) => e.target.select(),
  });
  const wrap = h("div.money",
    h("span.money__prefix", { text: symbol }),
    input,
    suffix && h("span.money__suffix", { text: suffix }),
  );
  wrap.input = input;
  return wrap;
}

export function textInput(props = {}) {
  return h("input.input", { type: "text", autocomplete: "off", ...props });
}

export function numberInput(props = {}) {
  return h("input.input", { type: "text", inputmode: "decimal", autocomplete: "off", ...props });
}

export function dateInput(props = {}) {
  return h("input.input", { type: "date", ...props });
}

export function select(options, { value, name, onchange } = {}) {
  const el = h("select.select", { name, onchange });
  for (const opt of options) {
    el.append(h("option", { value: opt.value, selected: String(opt.value) === String(value) },
      opt.label));
  }
  return el;
}

/**
 * Segmented control. `onChange` gets the new value; the pressed state is
 * updated here so callers don't re-render a whole screen to move a pill.
 */
export function segmented(options, value, onChange, { full = false, scroll = false } = {}) {
  const el = h(`div.seg${full ? ".seg--full" : ""}${scroll ? ".seg--scroll" : ""}`, { role: "group" });
  for (const opt of options) {
    el.append(h("button.seg__btn", {
      type: "button",
      "aria-pressed": String(opt.value) === String(value),
      onclick: () => {
        for (const b of el.children) b.setAttribute("aria-pressed", "false");
        el.querySelector(`[data-value="${CSS.escape(String(opt.value))}"]`)
          ?.setAttribute("aria-pressed", "true");
        onChange(opt.value);
      },
      dataset: { value: String(opt.value) },
    }, opt.label));
  }
  return el;
}

/** A value that turns into an editor when tapped. */
export function tapEdit(text, onTap, { className = "" } = {}) {
  return h(`button.tapedit${className ? `.${className}` : ""}`, {
    type: "button", onclick: onTap, "aria-label": `Edit ${text}`,
  }, text);
}

export function emptyState({ title, hint, actionLabel, onAction, icon = "empty" }) {
  return h("div.empty",
    h("div.empty__icon", { html: icons[icon] }),
    h("div.empty__title", { text: title }),
    hint && h("div.empty__hint", { text: hint }),
    actionLabel && h("button.btn.btn--primary.btn--sm", {
      type: "button", onclick: onAction, style: { marginTop: "var(--sp-2)" },
    }, actionLabel),
  );
}

export const spinner = () =>
  h("div.stack.stack--tight",
    h("div.skel.skel-block"), h("div.skel.skel-line"), h("div.skel.skel-line"));

// ── delete + undo ────────────────────────────────────────────────────────────

/**
 * Delete now, offer undo for a few seconds. `restore` re-creates the row from
 * whatever the DELETE response returned, so undo is exact rather than a
 * best-effort re-entry.
 */
export async function deleteWithUndo({ label, remove, restore, refresh }) {
  try {
    const result = await remove();
    await refresh?.();
    toast(`${label} deleted`, {
      undo: async () => {
        await restore(result?.deleted ?? result);
        await refresh?.();
        toast(`${label} restored`);
      },
    });
  } catch (err) {
    errorToast(err);
  }
}

/**
 * One-field edit sheet — the workhorse behind "tap any number to change it".
 * `parse` returns the value to send, or throws a message to show inline.
 */
export function editSheet({ title, subtitle, control, parse, onSave, extra, deleteAction }) {
  return openSheet({
    title,
    subtitle,
    build: () => frag(control, extra),
    footer: (close) => frag(
      deleteAction && h("button.btn.btn--danger", {
        type: "button",
        style: { flex: "0 0 auto" },
        onclick: async () => { close(); await deleteAction(); },
      }, iconEl("trash")),
      h("button.btn.btn--primary", {
        type: "button",
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            await onSave(parse());
            close();
          } catch (err) {
            errorToast(err);
            btn.disabled = false;
          }
        },
      }, "Save"),
    ),
  });
}
