import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import ModelContextLabel from './ModelContextLabel.js';

describe('ModelContextLabel', () => {
  it.each([undefined, 0, -1, 128000])('requires a value, source and timestamp before showing %s as known', (contextLength) => {
    let root!: ReturnType<typeof create>;
    act(() => { root = create(<ModelContextLabel contextLength={contextLength} />); });
    expect(JSON.stringify(root.toJSON())).toContain('上下文未知');
    act(() => root.unmount());
  });
  it('shows the explicit value and evidence without a guessed default', () => {
    let root!: ReturnType<typeof create>;
    act(() => { root = create(<ModelContextLabel contextLength={128000} contextSource="openai.models:context_length" contextUpdatedAt="2026-10-04T00:00:00Z" />); });
    expect(JSON.stringify(root.toJSON())).toContain('128,000');
    expect(root.root.findByType('span').props.title).toContain('openai.models:context_length');
    act(() => root.unmount());
  });
});
