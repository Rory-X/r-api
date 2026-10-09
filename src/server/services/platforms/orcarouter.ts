import { StandardApiProviderAdapterBase } from './standardApiProvider.js';
import { detectPlatformByUrlHint } from '../../../shared/platformIdentity.js';
import type { ModelDiscoveryMetadataSink } from '../../contracts/modelDiscovery.js';

export class OrcaRouterAdapter extends StandardApiProviderAdapterBase {
  readonly platformName = 'orcarouter';

  async detect(url: string): Promise<boolean> {
    return detectPlatformByUrlHint(url) === this.platformName;
  }

  async getModels(baseUrl: string, apiToken: string, _platformUserId?: number, onMetadata?: ModelDiscoveryMetadataSink): Promise<string[]> {
    return this.fetchModelsFromStandardEndpoint({
      baseUrl,
      onMetadata,
      headers: { Authorization: `Bearer ${apiToken}` },
    });
  }
}
