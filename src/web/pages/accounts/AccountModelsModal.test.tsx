import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import AccountModelsModal from './AccountModelsModal.js';

vi.mock('../../components/useAnimatedVisibility.js', () => ({
  useAnimatedVisibility: (open: boolean) => ({ shouldRender: open, isVisible: open }),
}));

function props(removingManualModel: string | null = null) {
  return {
    modelModal: {
      open: true, account: { id: 1 }, loading: false, saving: false, siteName: 'Test',
      models: [
        { name: 'manual-a', latencyMs: null, disabled: false, isManual: true },
        { name: 'synced-a', latencyMs: null, disabled: false, isManual: false },
      ],
      pendingDisabled: new Set<string>(), manualModelsInput: '', addingManualModels: false,
      removingManualModel,
    },
    inputStyle: {}, onClose: vi.fn(), onSave: vi.fn(), onRefresh: vi.fn(),
    onToggleModelDisabled: vi.fn(), onSetPendingDisabled: vi.fn(), onManualInputChange: vi.fn(),
    onAddManualModels: vi.fn(), onRemoveManualModel: vi.fn(),
  };
}

describe('manual model deletion control', () => {
  it('shows sourced context while making unknown models explicit', () => {
    const input = props();
    const models = input.modelModal.models.map((model, index) => ({
      ...model,
      ...(index === 0 ? { contextLength: 128000, contextSource: 'openai.models:context_length', contextUpdatedAt: '2026-10-04T00:00:00Z' } : {}),
    }));
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(<AccountModelsModal {...input} modelModal={{ ...input.modelModal, models }} />); });
    expect(JSON.stringify(renderer.toJSON())).toContain('128,000');
    expect(JSON.stringify(renderer.toJSON())).toContain('上下文未知');
    expect(renderer.root.findAll((node) => typeof node.props.title === 'string' && node.props.title.includes('openai.models:context_length'))).toHaveLength(1);
    act(() => renderer.unmount());
  });
  it('offers deletion only for manual models without toggling their disabled status', () => {
    const input = props();
    let renderer: ReturnType<typeof create>;
    act(() => { renderer = create(<AccountModelsModal {...input} />); });
    const buttons = renderer!.root.findAllByType('button')
      .filter((button) => String(button.props['aria-label'] || '').startsWith('删除手动模型'));
    expect(buttons).toHaveLength(1);
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    act(() => { buttons[0].props.onClick(event); });
    expect(input.onRemoveManualModel).toHaveBeenCalledWith('manual-a');
    expect(input.onToggleModelDisabled).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    act(() => { renderer!.unmount(); });
  });

  it('blocks overlapping model changes while a deletion is in progress', () => {
    let renderer: ReturnType<typeof create>;
    act(() => { renderer = create(<AccountModelsModal {...props('manual-a')} />); });
    const button = renderer!.root.findByProps({ 'aria-label': '删除手动模型 manual-a' });
    expect(button.props.disabled).toBe(true);
    expect(renderer!.root.findAllByType('input').every((input) => input.props.disabled)).toBe(true);
    act(() => { renderer!.unmount(); });
  });
});
