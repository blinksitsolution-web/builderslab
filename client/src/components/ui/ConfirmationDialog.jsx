import { useState } from "react";
import Modal from "./Modal";
import Button from "./Button";

/**
 * @param {boolean} open
 * @param {() => void} onClose
 * @param {() => void|Promise<void>} onConfirm
 * @param {string} title
 * @param {string} [confirmLabel]
 * @param {"primary"|"danger"} [confirmVariant]
 */
export default function ConfirmationDialog({ open, onClose, onConfirm, title, confirmLabel = "Confirm", confirmVariant = "primary", children }) {
  const [submitting, setSubmitting] = useState(false);

  async function handleConfirm() {
    setSubmitting(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant={confirmVariant} onClick={handleConfirm} loading={submitting}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
