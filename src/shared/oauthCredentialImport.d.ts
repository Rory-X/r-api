export type CanonicalOauthImportProvider = 'codex' | 'claude' | 'gemini-cli' | 'antigravity';

export type NormalizedOauthCredential = Record<string, unknown> & {
  type: CanonicalOauthImportProvider;
  access_token: string;
};

export type OauthCredentialImportIssue = {
  path: string;
  message: string;
};

export type OauthCredentialImportResult = {
  format: 'native' | 'array' | 'accounts-envelope' | 'wrapped';
  label: string;
  records: NormalizedOauthCredential[];
  issues: OauthCredentialImportIssue[];
};

export class OauthCredentialImportFormatError extends Error {
  constructor(message: string);
}

export function normalizeOauthCredentialImport(input: unknown): OauthCredentialImportResult;
