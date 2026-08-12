import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import SideDrawer from './SideDrawer.js';

vi.mock('react-dom', () => ({
  createPortal: (node: unknown) => node,
}));

vi.mock('./useAnimatedVisibility.js', () => ({
  useAnimatedVisibility: (open: boolean) => ({
    shouldRender: open,
    isVisible: open,
  }),
}));

describe('SideDrawer', () => {
  it('renders fixed header, scrollable body and fixed footer regions', async () => {
    const onClose = vi.fn();
    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <SideDrawer
            open
            onClose={onClose}
            title="编辑密钥"
            footer={<button type="button">保存</button>}
          >
            <div>表单内容</div>
          </SideDrawer>,
        );
      });

      expect(root.root.findByProps({ className: 'side-drawer-header' })).toBeTruthy();
      expect(root.root.findByProps({ className: 'side-drawer-body' })).toBeTruthy();
      expect(root.root.findByProps({ className: 'side-drawer-footer' })).toBeTruthy();
      expect(root.root.findByProps({ role: 'dialog' }).props['aria-modal']).toBe('true');

      const closeButton = root.root.findByProps({ 'aria-label': '关闭抽屉' });
      await act(async () => {
        closeButton.props.onClick();
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      root?.unmount();
    }
  });
});
