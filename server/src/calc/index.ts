/**
 * The calculation layer.
 *
 * Structure: `repo` reads SQLite into a `Ledger`; `engine` is pure maths over
 * that Ledger; `rsu` and `recurring` own the two write-side workflows. Nothing
 * here reaches the network.
 *
 * The whole model in one identity, at any date D:
 *     value(D) = net_principal(D) + net_earnings(D)
 *     gross_earnings(D) = net_earnings(D) + fees_paid(D)
 */

export * from "./money.js";
export * from "./dates.js";
export * from "./types.js";
export * from "./fx.js";
export * from "./returns.js";
export * from "./engine.js";
export * from "./repo.js";
export * as rsu from "./rsu.js";
export * as recurring from "./recurring.js";
export * as projection from "./projection.js";
