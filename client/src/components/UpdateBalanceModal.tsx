import { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Segment } from "./Segment";
import { useUpdateBalance } from "../hooks/useInvestments";
import type { Currency } from "@choopi/shared";
import type { Investment } from "../hooks/useInvestments";

const CCY_OPTIONS = [
  { value: "NIS" as Currency, label: "₪ NIS" },
  { value: "USD" as Currency, label: "$ USD" },
];

interface UpdateBalanceModalProps {
  investment: Investment | null;
  onClose: () => void;
}

export function UpdateBalanceModal({ investment, onClose }: UpdateBalanceModalProps) {
  const [balance, setBalance] = useState("");
  const [currency, setCurrency] = useState<Currency>("NIS");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const updateMut = useUpdateBalance();

  function handleClose() {
    onClose();
    setBalance("");
    setNotes("");
  }

  function handleSubmit() {
    if (!investment) return;
    const bal = Number(balance);
    if (isNaN(bal) || bal < 0) return;
    updateMut.mutate({
      id: investment.id,
      balance: bal,
      currency,
      occurred_at: new Date(date).toISOString(),
      notes: notes.trim() || undefined,
    }, { onSuccess: handleClose });
  }

  return (
    <Modal
      open={investment !== null}
      onClose={handleClose}
      title={`Update balance — ${investment?.name ?? ""}`}
      width={400}
    >
      <div className="cf-form" style={{ gap: 14 }}>
        <div className="cf-field">
          <label>New balance</label>
          <input
            type="number"
            min="0"
            step="any"
            placeholder="0"
            value={balance}
            onChange={e => setBalance(e.target.value)}
            autoFocus
          />
        </div>

        <div className="cf-field">
          <label>Currency</label>
          <Segment options={CCY_OPTIONS} value={currency} onChange={setCurrency} />
        </div>

        <div className="cf-field">
          <label>Date</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
          />
        </div>

        <div className="cf-field">
          <label>Notes (optional)</label>
          <input
            type="text"
            placeholder="e.g. Annual statement"
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </div>

        <div className="cf-modal-actions" style={{ marginTop: 8 }}>
          <Button variant="ghost" onClick={handleClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!balance || updateMut.isPending}
          >
            {updateMut.isPending ? "Saving…" : "Update balance"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
