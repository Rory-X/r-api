import { describe, expect, it } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import ModernSelect from './ModernSelect.js';

function collectText(node: ReturnType<typeof create>['root']): string {
  return node.findAll(() => true)
    .flatMap((instance) => instance.children)
    .filter((child): child is string => typeof child === 'string')
    .join('');
}

function collectInstanceText(node: ReactTestInstance): string {
  const children = node.children || [];
  return children.map((child) => {
    if (typeof child === 'string') return child;
    return collectInstanceText(child);
  }).join('');
}

describe('ModernSelect', () => {
  it('renders icon nodes for the selected option', () => {
    const root = create(
      <ModernSelect
        value="nvidia"
        onChange={() => {}}
        options={[
          {
            value: 'nvidia',
            label: 'NVIDIA',
            description: 'NVIDIA 品牌图标',
            iconNode: <span>🟢</span>,
          } as any,
        ]}
      />,
    );

    expect(collectText(root.root)).toContain('🟢');
    expect(collectText(root.root)).toContain('NVIDIA');
  });

  it('filters searchable options by label and description keywords', async () => {
    const root = create(
      <ModernSelect
        searchable
        searchPlaceholder="筛选站点"
        value=""
        onChange={() => {}}
        options={[
          { value: 'alpha', label: 'Alpha Mirror', description: 'https://alpha.example.com' },
          { value: 'beta', label: 'Beta Relay (codex)', description: 'https://beta.example.com' },
          { value: 'gamma', label: 'Gamma API', description: 'https://third.example.com' },
        ]}
      />,
    );

    const trigger = root.root.find((node) => (
      node.type === 'button'
      && typeof node.props.className === 'string'
      && node.props.className.includes('modern-select-trigger')
    ));

    await act(async () => {
      trigger.props.onClick();
    });

    const searchInput = root.root.find((node) => (
      node.type === 'input'
      && node.props.placeholder === '筛选站点'
    ));

    await act(async () => {
      searchInput.props.onChange({ target: { value: 'codex' } });
    });

    let optionButtons = root.root.findAll((node) => (
      node.type === 'button'
      && typeof node.props.className === 'string'
      && node.props.className.includes('modern-select-option')
    ));
    expect(optionButtons.map((node) => collectInstanceText(node))).toEqual(['Beta Relay (codex)https://beta.example.com']);

    await act(async () => {
      searchInput.props.onChange({ target: { value: 'third.example.com' } });
    });

    optionButtons = root.root.findAll((node) => (
      node.type === 'button'
      && typeof node.props.className === 'string'
      && node.props.className.includes('modern-select-option')
    ));
    expect(optionButtons.map((node) => collectInstanceText(node))).toEqual(['Gamma APIhttps://third.example.com']);
  });

  it('binds tooltip descriptions to individual option rows', () => {
    const root = create(
      <ModernSelect
        value="stable"
        onChange={() => {}}
        optionDescriptionTooltipSide="right"
        options={[
          { value: 'weighted', label: '权重随机', description: '按权重和健康度随机选择' },
          { value: 'stable', label: '稳定优先', description: '优先选择稳定站点' },
        ]}
      />,
    );

    const optionButtons = root.root.findAll((node) => (
      node.type === 'button'
      && typeof node.props.className === 'string'
      && node.props.className.includes('modern-select-option')
    ));

    expect(optionButtons.map((node) => ({
      tooltip: node.props['data-tooltip'],
      side: node.props['data-tooltip-side'],
    }))).toEqual([
      { tooltip: '按权重和健康度随机选择', side: 'right' },
      { tooltip: '优先选择稳定站点', side: 'right' },
    ]);
    expect(collectInstanceText(optionButtons[0])).toBe('权重随机');
    expect(optionButtons[0].props['aria-label']).toBe('权重随机: 按权重和健康度随机选择');

    root.unmount();
  });
});
