import React, { useCallback, useEffect, useRef, useState } from 'react';
import ConfirmDialog, { type ConfirmDialogProps } from './ConfirmDialog.js';

type ConfirmRequest = Pick<
  ConfirmDialogProps,
  'title' | 'description' | 'confirmLabel' | 'cancelLabel' | 'confirmVariant'
>;

type PendingConfirm = ConfirmRequest & {
  resolve: (confirmed: boolean) => void;
};

export function useConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);

  useEffect(() => () => {
    pendingRef.current?.resolve(false);
    pendingRef.current = null;
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(confirmed);
  }, []);

  const requestConfirmation = useCallback((request: ConfirmRequest) => new Promise<boolean>((resolve) => {
    pendingRef.current?.resolve(false);
    const next = { ...request, resolve };
    pendingRef.current = next;
    setPending(next);
  }), []);

  const confirmationDialog = (
    <ConfirmDialog
      open={pending !== null}
      title={pending?.title || '确认操作'}
      description={pending?.description || ''}
      confirmLabel={pending?.confirmLabel}
      cancelLabel={pending?.cancelLabel}
      confirmVariant={pending?.confirmVariant}
      onConfirm={() => settle(true)}
      onClose={() => settle(false)}
    />
  );

  return { requestConfirmation, confirmationDialog };
}
