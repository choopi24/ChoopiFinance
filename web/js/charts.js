/**
 * Chart.js wrappers.
 *
 * Everything a chart needs to be legible on a 390px screen is centralised here:
 * tick budgets, compact currency axes, touch-friendly hit areas, and a themed
 * palette rebuilt whenever light/dark flips. Screens pass data and nothing else.
 */

import { moneyCompact, money, pct, dateLabel, monthLabel, units } from "./fmt.js";
import { cssVar, labelFor, colorVarFor } from "./labels.js";
import { h, render, emptyState } from "./ui.js";

const Chart = window.Chart;

/** Every live chart, so a theme change can rebuild them with new colours. */
const live = new Set();

function theme() {
  return {
    text: cssVar("--text"),
    soft: cssVar("--text-soft"),
    faint: cssVar("--text-faint"),
    grid: cssVar("--border"),
    surface: cssVar("--surface"),
    accent: cssVar("--accent"),
    accentInk: cssVar("--accent-ink"),
    emerald: cssVar("--emerald"),
    rose: cssVar("--rose"),
    amber: cssVar("--amber"),
    font: cssVar("--font-sans") || "system-ui",
    mono: cssVar("--font-mono") || "monospace",
  };
}

/** rgba() from a hex token, for the translucent area fills. */
function alpha(hex, a) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  const [r, g, b] = [1, 2, 3].map(i => parseInt(m[i], 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Shared options. `responsive` + a fixed-height parent is what keeps the canvas
 * from growing without bound on resize.
 */
function baseOptions(t) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    // A finger is not a mouse pointer: hit the nearest point on the x axis
    // rather than demanding an exact intersection.
    interaction: { mode: "index", intersect: false },
    // Enough headroom that the topmost y tick is never clipped.
    layout: { padding: { top: 12, right: 4, bottom: 0, left: 0 } },
    plugins: {
      legend: { display: false }, // legends are rendered as real HTML below
      tooltip: {
        backgroundColor: t.text,
        titleColor: t.surface,
        bodyColor: t.surface,
        footerColor: t.surface,
        titleFont: { family: t.font, size: 12, weight: "600" },
        bodyFont: { family: t.mono, size: 13 },
        footerFont: { family: t.font, size: 11, weight: "500" },
        padding: 10,
        cornerRadius: 8,
        displayColors: true,
        boxWidth: 8,
        boxHeight: 8,
        boxPadding: 4,
        caretSize: 5,
      },
    },
  };
}

function timeAxis(t, labels) {
  return {
    grid: { display: false },
    border: { color: t.grid },
    ticks: {
      color: t.faint,
      font: { family: t.font, size: 10 },
      // A phone fits about five date labels before they collide.
      maxTicksLimit: labels.length > 24 ? 5 : 6,
      maxRotation: 0,
      autoSkip: true,
      padding: 4,
    },
  };
}

function moneyAxis(t, currency, { stacked = false } = {}) {
  return {
    stacked,
    beginAtZero: true,
    position: "right", // keeps the y labels off the left edge on a narrow screen
    grid: { color: t.grid, drawTicks: false },
    border: { display: false },
    ticks: {
      color: t.faint,
      font: { family: t.mono, size: 10 },
      maxTicksLimit: 5,
      padding: 6,
      // Chart data is carried in major units; moneyCompact speaks minor.
      callback: (v) => moneyCompact(v * 100, currency),
    },
  };
}

/**
 * Create (or replace) a chart inside `container`. Returns the Chart instance.
 * The factory is stashed so `retheme()` can rebuild it from scratch.
 */
function mount(container, factory) {
  for (const entry of live) {
    if (entry.container === container) { entry.chart.destroy(); live.delete(entry); }
  }
  const canvas = h("canvas");
  render(container, canvas);
  const chart = factory(canvas.getContext("2d"), theme());
  live.add({ container, factory, chart });
  return chart;
}

/** Rebuild every chart against the new palette. Called by the theme toggle. */
export function retheme() {
  for (const entry of [...live]) {
    const canvas = h("canvas");
    entry.chart.destroy();
    render(entry.container, canvas);
    entry.chart = entry.factory(canvas.getContext("2d"), theme());
  }
}

/** Drop every chart — screens call this before swapping their DOM out. */
export function destroyAll() {
  for (const entry of live) entry.chart.destroy();
  live.clear();
}

// ── stacked area: my money vs earnings ───────────────────────────────────────

/**
 * The main chart. Principal sits on the bottom because it is the floor the
 * portfolio is built on; earnings stack above it, and the top of the stack is
 * total value — the same number as the headline.
 *
 * A loss makes earnings negative, which no stacked area can draw honestly. In
 * that case the earnings band is split out below zero and coloured rose, so a
 * portfolio under water looks like one.
 */
export function stackedAreaChart(container, { points, currency }) {
  if (!points?.length || points.every(p => p.value_minor === 0)) {
    render(container, emptyState({
      title: "Nothing to chart yet",
      hint: "Add a deposit and a price or balance, and your money and earnings will show up here.",
      icon: "chart",
    }));
    return null;
  }

  const labels = points.map(p => p.date);
  const principal = points.map(p => p.principal_minor / 100);
  const earnings = points.map(p => p.earnings_minor / 100);
  const anyLoss = earnings.some(v => v < 0);

  return mount(container, (ctx, t) => new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "My money",
          data: principal,
          borderColor: t.accent,
          backgroundColor: alpha(t.accent, 0.22),
          fill: "origin",
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 24, // a fingertip, not a pixel
          tension: 0.25,
        },
        {
          label: anyLoss ? "Earnings / loss" : "Earnings",
          data: earnings,
          borderColor: anyLoss ? t.rose : t.emerald,
          backgroundColor: alpha(anyLoss ? t.rose : t.emerald, 0.22),
          fill: anyLoss ? "origin" : "-1",
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 24,
          tension: 0.25,
        },
      ],
    },
    options: {
      ...baseOptions(t),
      scales: {
        x: { ...timeAxis(t, labels), ticks: { ...timeAxis(t, labels).ticks,
          callback: (_v, i) => dateLabel(labels[i], { year: false }) } },
        y: moneyAxis(t, currency, { stacked: !anyLoss }),
      },
      plugins: {
        ...baseOptions(t).plugins,
        tooltip: {
          ...baseOptions(t).plugins.tooltip,
          callbacks: {
            title: (items) => dateLabel(labels[items[0].dataIndex], { year: true }),
            label: (item) => ` ${item.dataset.label}: ${money(item.raw * 100, currency)}`,
            footer: (items) => {
              const i = items[0].dataIndex;
              const p = points[i];
              const ret = p.principal_minor
                ? (p.earnings_minor / p.principal_minor) * 100 : null;
              return [
                `Total ${money(p.value_minor, currency)}`,
                ret == null ? "" : `Return ${pct(ret)}`,
                p.fees_minor ? `Fees paid ${money(p.fees_minor, currency)}` : "",
              ].filter(Boolean);
            },
          },
        },
      },
    },
  }));
}

// ── return % over time ───────────────────────────────────────────────────────

export function returnLineChart(container, { points }) {
  const usable = points?.filter(p => p.principal_minor > 0) ?? [];
  if (usable.length < 2) {
    render(container, emptyState({
      title: "No return to plot yet",
      hint: "Return needs at least two dates with money in the account. Add a deposit and a later price or balance.",
      icon: "chart",
    }));
    return null;
  }

  const labels = usable.map(p => p.date);
  const values = usable.map(p => (p.earnings_minor / p.principal_minor) * 100);

  return mount(container, (ctx, t) => new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Return",
        data: values,
        borderColor: t.accentInk,
        backgroundColor: alpha(t.accentInk, 0.15),
        fill: "origin",
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHitRadius: 24,
        tension: 0.25,
      }],
    },
    options: {
      ...baseOptions(t),
      scales: {
        x: { ...timeAxis(t, labels), ticks: { ...timeAxis(t, labels).ticks,
          callback: (_v, i) => dateLabel(labels[i], { year: false }) } },
        y: {
          position: "right",
          grid: { color: t.grid, drawTicks: false },
          border: { display: false },
          ticks: {
            color: t.faint,
            font: { family: t.mono, size: 10 },
            maxTicksLimit: 5,
            padding: 6,
            callback: (v) => `${v.toFixed(0)}%`,
          },
        },
      },
      plugins: {
        ...baseOptions(t).plugins,
        tooltip: {
          ...baseOptions(t).plugins.tooltip,
          callbacks: {
            title: (items) => dateLabel(labels[items[0].dataIndex], { year: true }),
            label: (item) => ` Return ${pct(item.raw)}`,
          },
        },
      },
    },
  }));
}

// ── allocation donut ─────────────────────────────────────────────────────────

export function donutChart(container, { slices, by, currency, total }) {
  if (!slices?.length) {
    render(container, emptyState({
      title: "Nothing allocated yet",
      hint: "Add an account with a price or a balance and the split will appear here.",
      icon: "empty",
    }));
    return null;
  }

  const labels = slices.map(s => labelFor(s.key, by));
  const colors = slices.map(s => cssVar(colorVarFor(s.key, by)));

  return mount(container, (ctx, t) => new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data: slices.map(s => s.value_minor / 100),
        backgroundColor: colors,
        borderColor: t.surface,
        borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "62%",
      layout: { padding: 6 },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...baseOptions(t).plugins.tooltip,
          callbacks: {
            label: (item) => {
              const share = total ? (item.raw * 100 / total) * 100 : 0;
              return ` ${money(item.raw * 100, currency)} · ${share.toFixed(1)}%`;
            },
          },
        },
      },
    },
  }));
}

// ── fees per month ───────────────────────────────────────────────────────────

export function feesBarChart(container, { months, currency }) {
  if (!months?.length || months.every(m => m.total_minor === 0)) {
    render(container, emptyState({
      title: "No fees recorded",
      hint: "Add a fee from the + button — management fees on your pension and hishtalmut are the ones worth tracking.",
      icon: "fee",
    }));
    return null;
  }

  const labels = months.map(m => m.month);

  return mount(container, (ctx, t) => new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Fees",
        data: months.map(m => m.total_minor / 100),
        backgroundColor: alpha(t.amber, 0.75),
        hoverBackgroundColor: t.amber,
        borderRadius: 4,
        maxBarThickness: 26,
      }],
    },
    options: {
      ...baseOptions(t),
      scales: {
        x: {
          grid: { display: false },
          border: { color: t.grid },
          ticks: {
            color: t.faint,
            font: { family: t.font, size: 10 },
            maxTicksLimit: 7,
            maxRotation: 0,
            autoSkip: true,
            callback: (_v, i) => monthLabel(labels[i]),
          },
        },
        y: moneyAxis(t, currency),
      },
      plugins: {
        ...baseOptions(t).plugins,
        tooltip: {
          ...baseOptions(t).plugins.tooltip,
          callbacks: {
            title: (items) => monthLabel(labels[items[0].dataIndex]),
            label: (item) => ` ${money(item.raw * 100, currency)}`,
            footer: (items) => {
              const kinds = months[items[0].dataIndex].by_kind || {};
              return Object.entries(kinds)
                .map(([k, v]) => `${k.replace(/_/g, " ")}: ${money(v, currency)}`);
            },
          },
        },
      },
    },
  }));
}

// ── RSU vesting timeline ─────────────────────────────────────────────────────

/**
 * One bar per vest date. Vested tranches are solid accent; upcoming ones are
 * drawn hollow — the distinction has to survive a greyscale screenshot, so it
 * is fill vs outline rather than two similar colours.
 */
export function vestingBarChart(container, { vests, asOf }) {
  if (!vests?.length) {
    render(container, emptyState({
      title: "No vesting schedule",
      hint: "Add a grant with its cliff and duration, and every tranche will be laid out here.",
      icon: "grant",
    }));
    return null;
  }

  const labels = vests.map(v => v.vest_date);
  const past = vests.map(v => (v.vest_date <= asOf ? v.units : null));
  const future = vests.map(v => (v.vest_date > asOf ? v.units : null));

  return mount(container, (ctx, t) => new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Vested",
          data: past,
          backgroundColor: t.accent,
          borderRadius: 3,
          maxBarThickness: 22,
        },
        {
          label: "Upcoming",
          data: future,
          backgroundColor: alpha(t.accent, 0.14),
          borderColor: t.accent,
          borderWidth: { top: 2, left: 2, right: 2, bottom: 0 },
          borderRadius: 3,
          maxBarThickness: 22,
        },
      ],
    },
    options: {
      ...baseOptions(t),
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          border: { color: t.grid },
          ticks: {
            color: t.faint,
            font: { family: t.font, size: 10 },
            maxTicksLimit: 6,
            maxRotation: 0,
            autoSkip: true,
            callback: (_v, i) => dateLabel(labels[i], { year: true }),
          },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          position: "right",
          grid: { color: t.grid, drawTicks: false },
          border: { display: false },
          ticks: {
            color: t.faint,
            font: { family: t.mono, size: 10 },
            maxTicksLimit: 4,
            padding: 6,
            callback: (v) => units(v, { max: 0 }),
          },
        },
      },
      plugins: {
        ...baseOptions(t).plugins,
        tooltip: {
          ...baseOptions(t).plugins.tooltip,
          callbacks: {
            title: (items) => dateLabel(labels[items[0].dataIndex], { year: true }),
            label: (item) => ` ${item.dataset.label}: ${units(item.raw)} units`,
          },
        },
      },
    },
  }));
}

/**
 * An HTML legend — real text that wraps, rather than clipped canvas labels.
 * `hollow` draws the swatch as an outline, matching the outlined bars used for
 * anything that hasn't happened yet.
 */
export function legend(entries) {
  return h("div.legend",
    ...entries.map(e => h("div.legend__item",
      h("span.legend__swatch", {
        style: e.hollow
          ? { border: `2px solid ${e.color}`, background: "transparent" }
          : { background: e.color },
      }),
      h("span", { text: e.label }),
      e.value && h("span.legend__value", { text: e.value }),
    )),
  );
}
