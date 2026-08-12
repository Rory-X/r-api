import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left';
type TooltipAlign = 'start' | 'center' | 'end';

type ActiveTooltip = {
  target: HTMLElement;
  text: string;
  side: TooltipSide;
  align: TooltipAlign;
};

type TooltipPosition = {
  left: number;
  top: number;
  arrowLeft: number;
  arrowTop: number;
  side: TooltipSide;
};

type RectLike = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readTooltipSide(target: HTMLElement): TooltipSide {
  const side = target.getAttribute('data-tooltip-side');
  return side === 'right' || side === 'bottom' || side === 'left' ? side : 'top';
}

function readTooltipAlign(target: HTMLElement): TooltipAlign {
  const align = target.getAttribute('data-tooltip-align');
  if (align === 'start' || align === 'end') return align;
  return 'center';
}

function resolveTooltipTarget(eventTarget: EventTarget | null): HTMLElement | null {
  if (!(eventTarget instanceof Element)) return null;
  const target = eventTarget.closest<HTMLElement>('[data-tooltip]');
  if (!target) return null;
  const text = target.getAttribute('data-tooltip');
  return text && text.trim() ? target : null;
}

export function resolveTooltipPosition({
  targetRect,
  bubbleRect,
  viewportWidth,
  viewportHeight,
  side,
  align,
  viewportPadding = 12,
  gap = 10,
}: {
  targetRect: RectLike;
  bubbleRect: Pick<RectLike, 'width' | 'height'>;
  viewportWidth: number;
  viewportHeight: number;
  side: TooltipSide;
  align: TooltipAlign;
  viewportPadding?: number;
  gap?: number;
}): TooltipPosition {
  let resolvedSide = side;
  if (
    side === 'right'
    && targetRect.right + gap + bubbleRect.width > viewportWidth - viewportPadding
    && targetRect.left - gap - bubbleRect.width >= viewportPadding
  ) {
    resolvedSide = 'left';
  } else if (
    side === 'left'
    && targetRect.left - gap - bubbleRect.width < viewportPadding
    && targetRect.right + gap + bubbleRect.width <= viewportWidth - viewportPadding
  ) {
    resolvedSide = 'right';
  } else if (
    side === 'bottom'
    && targetRect.bottom + gap + bubbleRect.height > viewportHeight - viewportPadding
    && targetRect.top - gap - bubbleRect.height >= viewportPadding
  ) {
    resolvedSide = 'top';
  } else if (
    side === 'top'
    && targetRect.top - gap - bubbleRect.height < viewportPadding
    && targetRect.bottom + gap + bubbleRect.height <= viewportHeight - viewportPadding
  ) {
    resolvedSide = 'bottom';
  }

  const horizontal = resolvedSide === 'left' || resolvedSide === 'right';
  let left: number;
  let top: number;

  if (horizontal) {
    left = resolvedSide === 'right'
      ? targetRect.right + gap
      : targetRect.left - gap - bubbleRect.width;
    if (align === 'start') top = targetRect.top;
    else if (align === 'end') top = targetRect.bottom - bubbleRect.height;
    else top = targetRect.top + targetRect.height / 2 - bubbleRect.height / 2;
  } else {
    if (align === 'start') left = targetRect.left;
    else if (align === 'end') left = targetRect.right - bubbleRect.width;
    else left = targetRect.left + targetRect.width / 2 - bubbleRect.width / 2;
    top = resolvedSide === 'bottom'
      ? targetRect.bottom + gap
      : targetRect.top - gap - bubbleRect.height;
  }

  left = clamp(left, viewportPadding, viewportWidth - viewportPadding - bubbleRect.width);
  top = clamp(top, viewportPadding, viewportHeight - viewportPadding - bubbleRect.height);

  const targetCenterX = targetRect.left + targetRect.width / 2;
  const targetCenterY = targetRect.top + targetRect.height / 2;
  return {
    left,
    top,
    arrowLeft: clamp(targetCenterX - left, 14, bubbleRect.width - 14),
    arrowTop: clamp(targetCenterY - top, 14, bubbleRect.height - 14),
    side: resolvedSide,
  };
}

export default function TooltipLayer() {
  const [activeTooltip, setActiveTooltip] = useState<ActiveTooltip | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const cancelFrame = useCallback(() => {
    if (rafRef.current === null || typeof window === 'undefined') return;
    window.cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const hideTooltip = useCallback(() => {
    cancelFrame();
    setActiveTooltip(null);
    setPosition(null);
  }, [cancelFrame]);

  const showTooltipForTarget = useCallback((target: HTMLElement | null) => {
    if (!target) {
      hideTooltip();
      return;
    }
    const text = target.getAttribute('data-tooltip')?.trim();
    if (!text) {
      hideTooltip();
      return;
    }

    setActiveTooltip({
      target,
      text,
      side: readTooltipSide(target),
      align: readTooltipAlign(target),
    });
  }, [hideTooltip]);

  const refreshPosition = useCallback(() => {
    if (!activeTooltip || !bubbleRef.current || typeof window === 'undefined') return;
    if (!activeTooltip.target.isConnected) {
      hideTooltip();
      return;
    }

    const targetRect = activeTooltip.target.getBoundingClientRect();
    const bubbleRect = bubbleRef.current.getBoundingClientRect();
    setPosition(resolveTooltipPosition({
      targetRect,
      bubbleRect,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      side: activeTooltip.side,
      align: activeTooltip.align,
    }));
  }, [activeTooltip, hideTooltip]);

  const scheduleRefresh = useCallback(() => {
    cancelFrame();
    if (typeof window === 'undefined') return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      refreshPosition();
    });
  }, [cancelFrame, refreshPosition]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.dataset.tooltipPortal = 'true';
    return () => {
      delete document.body.dataset.tooltipPortal;
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleMouseOver = (event: MouseEvent) => {
      showTooltipForTarget(resolveTooltipTarget(event.target));
    };

    const handleFocusIn = (event: FocusEvent) => {
      showTooltipForTarget(resolveTooltipTarget(event.target));
    };

    const handleMouseOut = (event: MouseEvent) => {
      if (!activeTooltip) return;
      const nextTarget = resolveTooltipTarget(event.relatedTarget);
      if (nextTarget === activeTooltip.target) return;
      if (event.relatedTarget instanceof Node && activeTooltip.target.contains(event.relatedTarget)) return;
      hideTooltip();
    };

    const handleFocusOut = (event: FocusEvent) => {
      if (!activeTooltip) return;
      const nextTarget = resolveTooltipTarget(event.relatedTarget);
      if (nextTarget === activeTooltip.target) return;
      if (event.relatedTarget instanceof Node && activeTooltip.target.contains(event.relatedTarget)) return;
      hideTooltip();
    };

    const handlePointerDown = (event: Event) => {
      if (!activeTooltip) return;
      if (event.target instanceof Node && activeTooltip.target.contains(event.target)) return;
      hideTooltip();
    };

    document.addEventListener('mouseover', handleMouseOver);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('mouseout', handleMouseOut);
    document.addEventListener('focusout', handleFocusOut);
    document.addEventListener('pointerdown', handlePointerDown);

    return () => {
      document.removeEventListener('mouseover', handleMouseOver);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('mouseout', handleMouseOut);
      document.removeEventListener('focusout', handleFocusOut);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [activeTooltip, hideTooltip, showTooltipForTarget]);

  useLayoutEffect(() => {
    if (!activeTooltip) return;
    setPosition(null);
    scheduleRefresh();
  }, [activeTooltip, scheduleRefresh]);

  useEffect(() => {
    if (!activeTooltip || typeof window === 'undefined') return;
    const handleViewportChange = () => scheduleRefresh();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [activeTooltip, scheduleRefresh]);

  useEffect(() => () => cancelFrame(), [cancelFrame]);

  if (!activeTooltip || typeof document === 'undefined') return null;

  const tooltip = (
    <div className="tooltip-layer" aria-hidden="true">
      <div
        ref={bubbleRef}
        className={`tooltip-bubble tooltip-bubble-${position?.side ?? activeTooltip.side} ${position ? 'is-visible' : ''}`.trim()}
        style={position ? {
          position: 'fixed',
          left: position.left,
          top: position.top,
        } : {
          position: 'fixed',
          left: 0,
          top: 0,
          visibility: 'hidden',
        }}
      >
        {activeTooltip.text}
        <span
          className={`tooltip-bubble-arrow tooltip-bubble-arrow-${position?.side ?? activeTooltip.side}`}
          style={position
            ? (position.side === 'left' || position.side === 'right'
              ? { top: position.arrowTop }
              : { left: position.arrowLeft })
            : undefined}
        />
      </div>
    </div>
  );

  return createPortal(tooltip, document.body);
}
