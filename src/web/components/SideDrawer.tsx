import React, { useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedVisibility } from './useAnimatedVisibility.js';
import Button from './ui/Button.js';

type SideDrawerProps = {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: number;
  bodyStyle?: React.CSSProperties;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  closeLabel?: string;
};

export default function SideDrawer({
  open,
  onClose,
  title,
  children,
  footer,
  maxWidth = 720,
  bodyStyle,
  closeOnBackdrop = true,
  closeOnEscape = true,
  closeLabel = '关闭抽屉',
}: SideDrawerProps) {
  const presence = useAnimatedVisibility(open, 220);
  const titleId = useId();
  const canUsePortal = typeof document !== 'undefined'
    && !!document.body
    && typeof document.body.appendChild === 'function'
    && typeof document.body.removeChild === 'function';

  useEffect(() => {
    if (!open || !canUsePortal) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [canUsePortal, open]);

  useEffect(() => {
    if (!open || !closeOnEscape || !canUsePortal) return;
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener('keydown', handleKeydown);
    };
  }, [canUsePortal, closeOnEscape, onClose, open]);

  if (!presence.shouldRender) return null;

  const drawer = (
    <div
      className={`side-drawer-root ${presence.isVisible ? '' : 'is-closing'}`.trim()}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <section
        className="side-drawer-panel"
        style={{ maxWidth }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="side-drawer-header">
          <div id={titleId} className="side-drawer-title">{title}</div>
          <Button
            variant="link"
            className="side-drawer-close"
            onClick={onClose}
            aria-label={closeLabel}
          >
            ×
          </Button>
        </div>
        <div className="side-drawer-body" style={bodyStyle}>
          {children}
        </div>
        {footer ? <div className="side-drawer-footer">{footer}</div> : null}
      </section>
    </div>
  );

  return canUsePortal ? createPortal(drawer, document.body) : drawer;
}
