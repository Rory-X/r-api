import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import BoundedHistoryList from './BoundedHistoryList.js';

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => (
    typeof child === 'string' ? child : collectText(child)
  )).join('');
}

describe('BoundedHistoryList', () => {
  it('keeps five rows in the page preview and paginates the modal history', async () => {
    const items = Array.from({ length: 25 }, (_, index) => ({ id: index + 1 }));
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <BoundedHistoryList
            items={items}
            getKey={(item) => item.id}
            renderItem={(item, context) => (
              <div data-history-row={item.id} data-history-modal={context.inModal}>记录 {item.id}</div>
            )}
            emptyText="暂无记录"
            modalTitle="全部记录"
          />,
        );
      });

      expect(root.root.findAll((node) => node.props['data-history-modal'] === false)).toHaveLength(5);
      const viewAll = root.root.find((node) => (
        node.type === 'button' && collectText(node).includes('查看全部（25）')
      ));
      await act(async () => { viewAll.props.onClick(); });

      expect(root.root.findAll((node) => node.props['data-history-modal'] === true)).toHaveLength(20);
      const nextPage = root.root.find((node) => node.type === 'button' && collectText(node) === '下一页');
      await act(async () => { nextPage.props.onClick(); });

      const secondPageIds = root.root
        .findAll((node) => node.props['data-history-modal'] === true)
        .map((node) => node.props['data-history-row']);
      expect(secondPageIds).toEqual([21, 22, 23, 24, 25]);
    } finally {
      root?.unmount();
    }
  });
});
