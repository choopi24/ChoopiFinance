import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { createPortal } from "react-dom";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

export function Modal({ open, onClose, title, children, footer, width = 520 }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="cf-modal-backdrop" onClick={onClose}>
      <div
        className="cf-modal"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="cf-modal-head">
            <span className="cf-modal-title">{title}</span>
            <button className="cf-modal-close" onClick={onClose} type="button">
              <X size={18} strokeWidth={1.6} />
            </button>
          </div>
        )}
        <div className="cf-modal-body">{children}</div>
        {footer && <div className="cf-modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
