/** Inference operations have distinct authorization/routing and ledger identities. */
export type ProxyEndpoint = 'chat' | 'messages' | 'responses' | 'rerank';
export type ProxyAttemptEndpoint = ProxyEndpoint | 'gemini-native' | 'gemini-internal' | 'responses-websocket';
