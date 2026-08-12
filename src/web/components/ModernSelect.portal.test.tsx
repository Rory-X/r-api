/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import ModernSelect from './ModernSelect.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  host?.remove();
  root = null;
  host = null;
});

describe('ModernSelect portal', () => {
  it('renders an open menu above sibling stacking contexts', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <ModernSelect
          value="retry"
          onChange={() => {}}
          options={[
            { value: 'retry', label: '继续重试' },
            { value: 'stop', label: '停止重试' },
          ]}
        />,
      );
    });

    const trigger = host.querySelector<HTMLButtonElement>('.modern-select-trigger');
    expect(trigger).not.toBeNull();
    trigger!.getBoundingClientRect = () => ({
      x: 80,
      y: 100,
      top: 100,
      right: 280,
      bottom: 140,
      left: 80,
      width: 200,
      height: 40,
      toJSON: () => ({}),
    });

    await act(async () => trigger!.click());

    const panel = document.body.querySelector<HTMLElement>('.modern-select-panel.is-portaled');
    expect(panel).not.toBeNull();
    expect(host.contains(panel)).toBe(false);
    expect(panel?.style.position).toBe('fixed');
    expect(panel?.style.left).toBe('80px');
    expect(panel?.style.top).toBe('148px');
    expect(panel?.style.width).toBe('200px');
  });
});
