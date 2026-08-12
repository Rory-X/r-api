import React, { type ReactNode } from 'react';
import CenteredModal from '../CenteredModal.js';
import Button, { type ButtonVariant } from './Button.js';

export type ConfirmDialogProps = {
  open: boolean;
  title: ReactNode;
  description: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  confirmVariant?: ButtonVariant;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  confirmVariant = 'danger',
  loading = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title={title}
      maxWidth={520}
      closeOnEscape={!loading}
      footer={(
        <>
          <Button data-testid="confirm-dialog-cancel" variant="ghost" disabled={loading} onClick={onClose}>{cancelLabel}</Button>
          <Button data-testid="confirm-dialog-confirm" variant={confirmVariant} loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      )}
    >
      <div className="ui-confirm-dialog-description">{description}</div>
    </CenteredModal>
  );
}
