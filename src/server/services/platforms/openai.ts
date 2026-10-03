import { StandardApiProviderAdapterBase } from './standardApiProvider.js';
import type { ModelDiscoveryMetadataSink } from '../../contracts/modelDiscovery.js';

export class OpenAiAdapter extends StandardApiProviderAdapterBase {
  readonly platformName = 'openai';

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    return normalized.includes('api.openai.com');
  }

  async getModels(baseUrl: string, apiToken: string, _platformUserId?: number, onMetadata?: ModelDiscoveryMetadataSink): Promise<string[]> {
    return this.fetchModelsFromStandardEndpoint({
      baseUrl,
      onMetadata,
      headers: { Authorization: `Bearer ${apiToken}` },
    });
  }
}
