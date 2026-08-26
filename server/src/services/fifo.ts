/**
 * FIFO lot engine — pure, no DB, no Express.
 *
 * Answers, for a market-priced account: how many units are still held, and what
 * did those units cost? The cost basis of *held* units is the money of yours
 * still sitting in the account (principal). Money released by a sell is split
 * into return-of-principal and realized gain.
 *
 * Callers map ledger rows into LotEvent[]; this file never touches SQL.
 */

export interface LotEvent {
  kind: "buy" | "sell";
  quantity: number;
  price_per_unit: number;
  /** YYYY-MM-DD — events must be passed in chronological order. */
  occurred_on: string;
}

export interface OpenLot {
  quantity: number;
  price_per_unit: number;
  occurred_on: string;
}

export interface FifoPosition {
  /** Units still held. */
  quantity: number;
  /** Cost basis of held units — the principal still invested. */
  cost_basis: number;
  /** Lifetime realized gain/loss from sells (not part of current value). */
  realized_gain: number;
  /** Lifetime gross proceeds taken out by sells. */
  proceeds: number;
  /** Surviving buy lots, oldest first. */
  lots: OpenLot[];
  /** A sell that exceeded units on hand — signals a data-entry mistake. */
  oversold_units: number;
}

// Sub-unit float noise guard (crypto fractions go deep).
const EPSILON = 1e-10;

/**
 * Walk events chronologically, matching sells against the oldest open lots.
 * Sells beyond available units are reported via `oversold_units` rather than
 * throwing — a personal tracker should surface the mistake, not refuse to load.
 */
export function fifoPosition(events: LotEvent[]): FifoPosition {
  const lots: OpenLot[] = [];
  let realized_gain = 0;
  let proceeds = 0;
  let oversold_units = 0;

  const ordered = [...events].sort((a, b) => a.occurred_on.localeCompare(b.occurred_on));

  for (const e of ordered) {
    if (e.quantity <= 0) continue;

    if (e.kind === "buy") {
      lots.push({
        quantity: e.quantity,
        price_per_unit: e.price_per_unit,
        occurred_on: e.occurred_on,
      });
      continue;
    }

    // sell — consume oldest lots first
    let remaining = e.quantity;
    proceeds += e.quantity * e.price_per_unit;

    while (remaining > EPSILON && lots.length > 0) {
      const lot = lots[0];
      const taken = Math.min(lot.quantity, remaining);
      realized_gain += taken * (e.price_per_unit - lot.price_per_unit);
      lot.quantity -= taken;
      remaining -= taken;
      if (lot.quantity < EPSILON) lots.shift();
    }
    if (remaining > EPSILON) oversold_units += remaining;
  }

  const quantity = lots.reduce((s, l) => s + l.quantity, 0);
  const cost_basis = lots.reduce((s, l) => s + l.quantity * l.price_per_unit, 0);

  return { quantity, cost_basis, realized_gain, proceeds, lots, oversold_units };
}
