import { useEffect, useRef, type ReactNode } from "react";
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
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Move focus into the dialog on open and restore it to the trigger on close.
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => prev?.focus?.();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="cf-modal-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className="cf-modal"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
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
