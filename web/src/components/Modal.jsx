import { useEffect } from "react";
import Icon from "./Icon";

export default function Modal({ open, onClose, title, subtitle, icon, wide, children, footer }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    // Stop the page behind the modal from scrolling.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          {icon && (
            <div className="list-icon" style={{ width: 40, height: 40, borderRadius: 12 }}>
              <Icon name={icon} size={19} />
            </div>
          )}
          <div className="grow">
            <h3 style={{ fontSize: 18, fontWeight: 800 }}>{title}</h3>
            {subtitle && <p className="hint" style={{ marginTop: 3 }}>{subtitle}</p>}
          </div>
          <button className="btn btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="close" size={17} />
          </button>
        </div>

        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// Small confirm dialog used for destructive actions (removing a device, etc.)
export function ConfirmModal({ open, onClose, onConfirm, title, message, confirmLabel = "Confirm", danger, busy }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      icon={danger ? "warning" : "alert"}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <span className="spinner" /> : confirmLabel}
          </button>
        </>
      }
    >
      <p className="hint" style={{ fontSize: 13.5 }}>{message}</p>
    </Modal>
  );
}
