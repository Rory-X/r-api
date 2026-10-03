import React from 'react';

export type ModelContextEvidence = {
  contextLength?: number | null;
  contextSource?: string | null;
  contextUpdatedAt?: string | null;
};

export default function ModelContextLabel(model: ModelContextEvidence) {
  const known = typeof model.contextLength === 'number' && Number.isSafeInteger(model.contextLength)
    && model.contextLength > 0 && !!model.contextSource && !!model.contextUpdatedAt;
  return (
    <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
      title={known ? `来源：${model.contextSource}；更新：${model.contextUpdatedAt}` : undefined}>
      {known ? `上下文 ${model.contextLength!.toLocaleString()} tokens` : '上下文未知'}
    </span>
  );
}
