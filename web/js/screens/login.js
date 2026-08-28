/**
 * The passcode screen.
 *
 * A numeric keypad rather than a text field, because this is opened one-handed
 * on a sofa: the keys are where the thumb already is, they are far bigger than
 * anything a soft keyboard offers, and nothing shifts the layout when the
 * keyboard appears. A hardware keyboard still works — digits, backspace and
 * Enter are all bound — so the Mac is no worse off.
 *
 * On first run the same screen sets the passcode, confirming it twice.
 */

import { api } from "../api.js";
import { h, render, iconEl, errorToast, toast } from "../ui.js";

const MIN_DIGITS = 4;
const MAX_DIGITS = 12;

export function loginScreen({ setupRequired, locked, retryInSeconds, onDone }) {
  // In setup mode the first entry is remembered and confirmed by the second.
  let stage = setupRequired ? "choose" : "unlock";
  let firstEntry = "";
  let digits = "";
  let busy = false;

  const dots = h("div.pin__dots", { "aria-hidden": "true" });
  const message = h("div.pin__message", { role: "status", "aria-live": "polite" });
  const title = h("h1.pin__title");
  const submit = h("button.btn.btn--primary.btn--lg.btn--block", { type: "button" });

  const STAGE_TEXT = {
    choose: { title: "Choose a passcode", action: "Continue",
      hint: `${MIN_DIGITS}–${MAX_DIGITS} digits. You'll need it on every device.` },
    confirm: { title: "Repeat it", action: "Set passcode", hint: "Just to be sure." },
    unlock: { title: "Enter your passcode", action: "Unlock", hint: "" },
  };

  function syncView() {
    const text = STAGE_TEXT[stage];
    title.textContent = text.title;
    submit.textContent = text.action;
    submit.disabled = busy || digits.length < MIN_DIGITS;

    render(dots, ...Array.from({ length: Math.max(MIN_DIGITS, digits.length) }, (_, i) =>
      h(`span.pin__dot${i < digits.length ? ".pin__dot--filled" : ""}`)));

    if (!message.dataset.sticky) message.textContent = text.hint;
  }

  function setMessage(text, { error = false, sticky = false } = {}) {
    message.textContent = text;
    message.classList.toggle("pin__message--error", error);
    if (sticky) message.dataset.sticky = "1";
    else delete message.dataset.sticky;
  }

  function press(digit) {
    if (busy || digits.length >= MAX_DIGITS) return;
    digits += digit;
    delete message.dataset.sticky;
    syncView();
  }

  function backspace() {
    if (busy) return;
    digits = digits.slice(0, -1);
    syncView();
  }

  async function commit() {
    if (busy || digits.length < MIN_DIGITS) return;

    if (stage === "choose") {
      firstEntry = digits;
      digits = "";
      stage = "confirm";
      syncView();
      return;
    }

    if (stage === "confirm") {
      if (digits !== firstEntry) {
        digits = "";
        firstEntry = "";
        stage = "choose";
        syncView();
        setMessage("Those didn't match. Start again.", { error: true, sticky: true });
        return;
      }
      await send(() => api.auth.setup(digits), "Passcode set");
      return;
    }

    await send(() => api.auth.unlock(digits), null);
  }

  async function send(call, successMessage) {
    busy = true;
    syncView();
    try {
      await call();
      if (successMessage) toast(successMessage);
      onDone();
    } catch (err) {
      digits = "";
      busy = false;
      syncView();
      setMessage(err.message, { error: true, sticky: true });
      // A wrong passcode should feel like a wrong passcode, not like a toast
      // you might miss — but the toast carries the lockout warning too.
      if (err.status === 429) errorToast(err);
    }
  }

  submit.onclick = commit;

  // ── the keypad ─────────────────────────────────────────────────────────────

  const key = (label, onClick, cls = "") =>
    h(`button.pinkey${cls}`, {
      type: "button",
      onclick: onClick,
      "aria-label": typeof label === "string" ? label : undefined,
    }, label);

  const keypad = h("div.pinpad",
    ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(d => key(d, () => press(d))),
    h("span"), // empty cell, so 0 sits under 8 like every phone keypad
    key("0", () => press("0")),
    key(iconEl("back"), backspace, ".pinkey--soft"),
  );

  // A hardware keyboard is the primary input on the desktop, so bind it too.
  function onKeyDown(e) {
    if (e.key >= "0" && e.key <= "9") { press(e.key); e.preventDefault(); }
    else if (e.key === "Backspace") { backspace(); e.preventDefault(); }
    else if (e.key === "Enter") { commit(); e.preventDefault(); }
  }
  document.addEventListener("keydown", onKeyDown);

  const card = h("div.pin",
    h("div.login__brand", h("img", { src: "/icons/icon-192.png", alt: "" }), "Choopi Finance"),
    title,
    dots,
    message,
    keypad,
    submit,
    setupRequired
      ? h("p.faint.pin__foot", {
          text: "This is stored as a hash on the server, never in the repo. Forgotten it later? Run `npm run set-pin` on the machine that hosts this.",
        })
      : h("p.faint.pin__foot", {
          text: "Only devices on your own network can reach this screen.",
        }),
  );

  if (locked) {
    setMessage(
      `Locked after too many wrong passcodes. Try again in about ${Math.ceil((retryInSeconds ?? 0) / 60)} minute(s).`,
      { error: true, sticky: true }
    );
  }
  syncView();

  const screen = h("div.login", card);
  // The listener outlives this node otherwise — every failed unlock would add
  // another one and digits would arrive twice.
  screen.cleanup = () => document.removeEventListener("keydown", onKeyDown);
  return screen;
}
