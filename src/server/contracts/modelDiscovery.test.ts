import { describe, expect, it } from 'vitest';
import { captureModelContextMetadata, modelContextColumns, modelContextMetadata, normalizeContextLength, normalizeDiscoveredModels, readModelContextEvidence } from './modelDiscovery.js';

describe('model context evidence', () => {
  it.each([undefined, null, false, true, 0, -1, 1.5, Infinity, NaN, '', '1M', '0x10', '1e6', '  ', 2_147_483_648, Number.MAX_SAFE_INTEGER + 1])('rejects invalid context %s', (value) => {
    expect(normalizeContextLength(value)).toBeUndefined();
  });
  it('accepts explicit positive integer fields and resolves conflicting evidence conservatively', () => {
    expect(modelContextMetadata({ context_length: ' 128000 ', contextWindow: 64000 }, 'provider.models')).toEqual({
      contextLength: 64000, contextSource: 'provider.models:contextWindow',
    });
    expect(modelContextMetadata({ inputTokenLimit: 1000000, outputTokenLimit: 8192 }, 'gemini.models')).toEqual({});
    expect(modelContextMetadata({}, 'provider.models')).toEqual({});
  });
  it('keeps names-only catalogs unknown and requires a source for supplied limits', () => {
    expect(normalizeDiscoveredModels([' model ', 'MODEL', { modelName: 'other', contextLength: 1000000 }])).toEqual([
      { modelName: 'model' }, { modelName: 'other' },
    ]);
    expect(modelContextColumns({ modelName: 'unknown' }, '2026-10-04T00:00:00Z')).toEqual({
      contextLength: null, contextSource: null, contextUpdatedAt: null,
    });
  });
  it('captures only returned model rows without inventing default values', () => {
    let captured: unknown;
    captureModelContextMetadata([{ id: 'a', context_length: 32000 }, { id: 'b' }], 'openai.models', (models) => { captured = models; });
    expect(captured).toEqual([{ modelName: 'a', contextLength: 32000, contextSource: 'openai.models:context_length' }, { modelName: 'b' }]);
  });
  it.each(['context_length', 'contextLength', 'max_context_length', 'maxContextLength', 'context_window', 'contextWindow'])('accepts explicit %s evidence', (field) => {
    expect(modelContextMetadata({ [field]: 64000 }, 'test.models')).toEqual({ contextLength: 64000, contextSource: `test.models:${field}` });
  });
  it('never publishes incomplete or damaged persisted evidence', () => {
    const evidence = { contextLength: 128000, contextSource: 'test.models:context_length', contextUpdatedAt: '2026-10-04T00:00:00Z' };
    expect(readModelContextEvidence(evidence)).toEqual(evidence);
    expect(readModelContextEvidence({ ...evidence, contextLength: -1 })).toBeUndefined();
    expect(readModelContextEvidence({ ...evidence, contextSource: '' })).toBeUndefined();
    expect(readModelContextEvidence({ ...evidence, contextUpdatedAt: 'invalid' })).toBeUndefined();
  });
});
