/**
 * Inline SVG icons, drawn on a 24px grid with a 2px stroke.
 *
 * Inline rather than an icon font or a sprite sheet: they inherit currentColor,
 * cost no request, and there is no runtime fetch anywhere in this app by design.
 */

const svg = (paths, { size = 24 } = {}) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons = {
  home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
  wallet: svg('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a1 1 0 0 1 1 1v2"/><path d="M3 7.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a1 1 0 0 0-1-1H5.5A2.5 2.5 0 0 1 3 7.5Z"/><circle cx="16.5" cy="14" r="1.2" fill="currentColor" stroke="none"/>'),
  grant: svg('<path d="M12 3v4"/><path d="M5 7h14l-1.4 12.1a2 2 0 0 1-2 1.9H8.4a2 2 0 0 1-2-1.9Z"/><path d="M9 12h6"/><path d="M9 16h4"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H10a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V10a1.7 1.7 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  back: svg('<path d="M15 18 9 12l6-6"/>'),
  chevron: svg('<path d="M9 6l6 6-6 6"/>'),
  pencil: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  trash: svg('<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>'),
  deposit: svg('<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>'),
  price: svg('<path d="M3 17l5-6 4 3 5-7 4 4"/><path d="M3 21h18"/>'),
  balance: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/>'),
  fee: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5h5"/><path d="M9.5 14.5h5"/><path d="M15 7 9 17"/>'),
  alert: svg('<path d="M12 3.5 21 19H3Z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>'),
  chart: svg('<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>'),
  repeat: svg('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  download: svg('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>'),
  upload: svg('<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M4 3h16"/>'),
  save: svg('<path d="M5 4h11l3 3v13H5Z"/><path d="M8 4v5h7V4"/><path d="M8 20v-6h8v6"/>'),
  check: svg('<path d="m4 12 5 5L20 6"/>'),
  empty: svg('<path d="M4 7.5 12 4l8 3.5v9L12 20l-8-3.5Z"/><path d="M4 7.5 12 11l8-3.5M12 11v9"/>'),
  sun: svg('<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svg('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>'),
};

/** Icon markup at a size other than 24 — used by the tab bar and buttons. */
export const icon = (name, size) =>
  size ? icons[name].replace(/width="24" height="24"/, `width="${size}" height="${size}"`) : icons[name];
