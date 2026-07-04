import { AlertTriangle } from "lucide-react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { useTxCount, useDeleteInvestment } from "../hooks/useInvestments";

interface DeleteConfirmModalProps {
  investmentId: number | null;
  onClose: () => void;
  onDeleted?: () => void;
}

export function DeleteConfirmModal({ investmentId, onClose, onDeleted }: DeleteConfirmModalProps) {
  const { data: info } = useTxCount(investmentId);
  const deleteMut = useDeleteInvestment();

  const name = info?.name ?? "";

  function handleDelete() {
    if (!investmentId) return;
    deleteMut.mutate(investmentId, {
      onSuccess: () => {
        onDeleted?.();
        onClose();
      },
    });
  }

  return (
    <Modal open={investmentId !== null} onClose={onClose} title="" width={440} className="is-danger">
      <div className="cf-delete-modal">
        <div className="cf-delete-icon">
          <AlertTriangle size={22} strokeWidth={1.6} />
        </div>
        <h3 className="cf-delete-title">Delete "{name}"?</h3>

        {info && (
          <ul className="cf-delete-consequences">
            <li>{info.tx_count} transaction{info.tx_count !== 1 ? "s" : ""} will be removed</li>
            {info.realized_count > 0 && (
              <li>{info.realized_count} realized P/L event{info.realized_count !== 1 ? "s" : ""} will be removed</li>
            )}
            <li>This action cannot be undone</li>
          </ul>
        )}

        <div className="cf-modal-actions" style={{ marginTop: 20 }}>
          <Button variant="ghost" onClick={onClose} fullWidth>Cancel</Button>
          <Button
            variant="danger"
            onClick={handleDelete}
            disabled={deleteMut.isPending}
            fullWidth
          >
            {deleteMut.isPending ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
