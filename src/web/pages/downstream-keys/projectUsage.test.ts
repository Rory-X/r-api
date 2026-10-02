import { describe, expect, it } from 'vitest';
import { buildProjectUsageSummaries, type SummaryItem } from './shared.js';

function item(input: {
  id: number;
  groupName: string | null;
  requests: number;
  success: number;
  tokens: number;
  cost: number;
}): SummaryItem {
  return {
    id: input.id,
    name: `key-${input.id}`,
    keyMasked: 'sk-***',
    enabled: true,
    description: null,
    groupName: input.groupName,
    tags: [],
    expiresAt: null,
    maxCost: null,
    usedCost: 0,
    maxRequests: null,
    usedRequests: 0,
    maxConcurrency: null,
    policyVersion: 1,
    supportedModels: [],
    allowedRouteIds: [],
    siteWeightMultipliers: {},
    excludedSiteIds: [],
    allowedCredentialRefs: [],
    excludedCredentialRefs: [],
    lastUsedAt: null,
    createdAt: null,
    updatedAt: null,
    rangeUsage: {
      totalRequests: input.requests,
      successRequests: input.success,
      failedRequests: input.requests - input.success,
      successRate: null,
      totalTokens: input.tokens,
      totalCost: input.cost,
    },
  };
}

describe('downstream project usage', () => {
  it('rolls multiple keys into a project-level usage and cost report', () => {
    expect(buildProjectUsageSummaries([
      item({ id: 1, groupName: 'Project A', requests: 4, success: 3, tokens: 100, cost: 0.2 }),
      item({ id: 2, groupName: 'Project A', requests: 6, success: 5, tokens: 200, cost: 0.3 }),
      item({ id: 3, groupName: null, requests: 2, success: 2, tokens: 50, cost: 0.1 }),
    ])).toEqual([
      expect.objectContaining({
        projectKey: 'Project A',
        projectName: 'Project A',
        keyCount: 2,
        totalRequests: 10,
        successRate: 80,
        totalTokens: 300,
        totalCost: 0.5,
      }),
      expect.objectContaining({
        projectKey: '__ungrouped__',
        projectName: '未分组项目',
        keyCount: 1,
        totalRequests: 2,
        totalCost: 0.1,
      }),
    ]);
  });
});
