import { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { useContribute } from "../hooks/useInvestments";
import { fmt } from "../lib/fmt";
import type { Currency } from "@choopi/shared";
import type { Investment } from "../hooks/useInvestments";

interface AddDepositModalProps {
  investment: Investment | null;
  /** Display currency + fx for showing balances; the contribution is recorded in the fund's own currency. */
  currency: Currency;
  fxRate: number;
  onClose: () => void;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function AddDepositModal({ investment, fxRate, onClose }: AddDepositModalProps) {
  const [amount, setAmount] = useState("");
  const [date, setDate]     = useState(today);
  const [notes, setNotes]   = useState("");
  const contribute = useContribute();

  function handleClose() {
    onClose();
    setAmount("");
    setNotes("");
    setDate(today());
  }

  if (!investment) return null;

  // The fund's working currency is whatever its last balance snapshot used.
  const fundCcy = (investment.currency as Currency) ?? "NIS";
  const amt = Number(amount);
  const amtValid = amount !== "" && !isNaN(amt) && amt > 0;
  // Show the projected new balance in the fund's own currency (what actually gets stored).
  const curValueFund = fundCcy === "NIS" ? investment.current_value_nis : investment.current_value_nis / fxRate;
  const newBalanceFund = curValueFund + (amtValid ? amt : 0);

  function handleSubmit() {
    if (!investment || !amtValid) return;
    contribute.mutate({
      id: investment.id,
      amount: amt,
      currency: fundCcy,
      occurred_at: new Date(date).toISOString(),
      notes: notes.trim() || undefined,
    }, { onSuccess: handleClose });
  }

  return (
    <Modal
      open
      onClose={handleClose}
      title={`Add deposit — ${investment.name}`}
      width={420}
    >
      <div className="cf-form" style={{ gap: 14 }}>
        <p style={{ fontSize: 13, color: "var(--text-soft)", margin: 0, lineHeight: 1.5 }}>
          Records new money you put in. It raises the fund's balance and its net deposited by the
          same amount, so the contribution is <strong>not</strong> counted as profit. Use{" "}
          <strong>Update balance</strong> instead when reporting growth from a statement.
        </p>

        <div className="cf-field">
          <label>Deposit amount ({fundCcy})</label>
          <input
            type="number"
            min="0"
            step="any"
            placeholder="0"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            autoFocus
          />
        </div>

        <div className="cf-field">
          <label>Date</label>
          <input
            type="date"
            value={date}
            max={today()}
            onChange={e => setDate(e.target.value)}
          />
        </div>

        <div className="cf-field">
          <label>Notes (optional)</label>
          <input
            type="text"
            placeholder="e.g. Monthly contribution"
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </div>

        <div
          style={{
            display: "flex", justifyContent: "space-between", gap: 12,
            padding: "10px 12px", background: "var(--surface-2)", borderRadius: "var(--r-sm)",
            fontSize: 13,
          }}
        >
          <span style={{ color: "var(--text-soft)" }}>Balance after deposit</span>
          <span className="mono" style={{ fontWeight: 600 }}>
            {fmt(newBalanceFund, { currency: fundCcy })}
          </span>
        </div>

        <div className="cf-modal-actions" style={{ marginTop: 8 }}>
          <Button variant="ghost" onClick={handleClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!amtValid || contribute.isPending}
          >
            {contribute.isPending ? "Saving…" : "Add deposit"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
