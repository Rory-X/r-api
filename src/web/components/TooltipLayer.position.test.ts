import { describe, expect, it } from 'vitest';
import { resolveTooltipPosition } from './TooltipLayer.js';

const targetRect = {
  left: 300,
  top: 200,
  right: 468,
  bottom: 240,
  width: 168,
  height: 40,
};

describe('resolveTooltipPosition', () => {
  it('places a right-side tooltip beside and vertically centered on its target', () => {
    expect(resolveTooltipPosition({
      targetRect,
      bubbleRect: { width: 280, height: 100 },
      viewportWidth: 1200,
      viewportHeight: 800,
      side: 'right',
      align: 'center',
    })).toEqual({
      left: 478,
      top: 170,
      arrowLeft: 14,
      arrowTop: 50,
      side: 'right',
    });
  });

  it('flips a right-side tooltip to the left when the viewport has no room', () => {
    expect(resolveTooltipPosition({
      targetRect: { ...targetRect, left: 700, right: 868 },
      bubbleRect: { width: 280, height: 100 },
      viewportWidth: 900,
      viewportHeight: 800,
      side: 'right',
      align: 'center',
    })).toEqual(expect.objectContaining({
      left: 410,
      side: 'left',
    }));
  });
});
