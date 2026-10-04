export type ProviderProfileId =
  | 'codex'
  | 'claude'
  | 'gemini-cli'
  | 'antigravity'
  | 'gemini';

export type ProviderEndpoint =
  | 'chat'
  | 'messages'
  | 'responses';

export type ProviderAction =
  | 'generateContent'
  | 'streamGenerateContent'
  | 'countTokens';

export type ProviderRuntimeDescriptor = {
  executor: 'default' | 'codex' | 'gemini-cli' | 'antigravity' | 'claude' | 'gemini-native';
  modelName?: string;
  stream?: boolean;
  oauthProjectId?: string | null;
  action?: ProviderAction;
};

export type PreparedProviderRequest = {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  runtime: ProviderRuntimeDescriptor;
};

export type PrepareProviderRequestInput = {
  endpoint: ProviderEndpoint;
  modelName: string;
  stream: boolean;
  tokenValue: string;
  oauthProvider?: string;
  oauthProjectId?: string;
  sitePlatform?: string;
  baseHeaders: Record<string, string>;
  providerHeaders?: Record<string, string>;
  claudeHeaders?: Record<string, string>;
  codexSessionCacheKey?: string | null;
  codexExplicitSessionId?: string | null;
  responsesWebsocketTransport?: boolean;
  body: Record<string, unknown>;
  action?: ProviderAction;
};

export type ProviderProfile = {
  id: ProviderProfileId;
  prefersNativeChat?: (body: Record<string, unknown>) => boolean;
  prepareRequest(input: PrepareProviderRequestInput): PreparedProviderRequest;
};
