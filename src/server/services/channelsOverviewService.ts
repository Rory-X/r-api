import { asc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  getCredentialModeFromExtraConfig,
  hasOauthProvider,
  type AccountCredentialMode,
} from './accountExtraConfig.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { isOauthProviderSite } from './oauth/oauthSiteRegistry.js';
import { normalizeSiteApiEndpointBaseUrl } from './siteApiEndpointService.js';
import {
  listSiteRuntimeHealthSnapshots,
  type SiteRuntimeHealthSnapshot,
} from './tokenRouter.js';

type SiteRow = typeof schema.sites.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;
type SiteApiEndpointRow = typeof schema.siteApiEndpoints.$inferSelect;

export type ChannelOverviewConnection = {
  id: number;
  siteId: number;
  username: string | null;
  status: string | null;
  credentialMode: AccountCredentialMode;
};

export type ChannelOverviewOauthConnection = {
  accountId: number;
  siteId: number;
  provider: string;
  username: string | null;
  email: string | null;
  status: string | null;
};

export type ChannelOverviewCredential = {
  id: number;
  siteId: number | null;
  accountId: number | null;
  name: string;
  kind: string;
  status: string;
  fingerprint: string;
  metadata: Record<string, unknown> | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ChannelOverviewChannel = Pick<
  SiteRow,
  | 'id'
  | 'name'
  | 'url'
  | 'homepageUrl'
  | 'platform'
  | 'status'
  | 'isPinned'
  | 'sortOrder'
  | 'globalWeight'
  | 'createdAt'
  | 'updatedAt'
> & {
  apiEndpoints: SiteApiEndpointRow[];
  runtimeHealth: SiteRuntimeHealthSnapshot[];
  connectionCount: number;
  activeConnectionCount: number;
  credentialCount: number;
  activeCredentialCount: number;
};

export type ChannelsOverviewReadModel = {
  generatedAt: string;
  channels: ChannelOverviewChannel[];
  connections: ChannelOverviewConnection[];
  oauthConnections: ChannelOverviewOauthConnection[];
  credentials: ChannelOverviewCredential[];
  totals: {
    sites: number;
    ordinaryConnections: number;
    officialConnections: number;
    activeCredentials: number;
  };
};

export type ChannelHealthReadModel = {
  generatedAt: string;
  total: number;
  items: SiteRuntimeHealthSnapshot[];
};

function hasStoredSessionToken(account: AccountRow): boolean {
  return typeof account.accessToken === 'string' && account.accessToken.trim().length > 0;
}

function resolveCredentialMode(account: AccountRow): AccountCredentialMode {
  const configured = getCredentialModeFromExtraConfig(account.extraConfig);
  if (configured && configured !== 'auto') return configured;
  return hasStoredSessionToken(account) ? 'session' : 'apikey';
}

function normalizeStatus(value: string | null | undefined): string {
  return String(value || 'active').trim().toLowerCase() || 'active';
}

function parseCredentialMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function groupBySiteId<T extends { siteId: number }>(rows: T[]): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const row of rows) {
    const current = grouped.get(row.siteId) || [];
    current.push(row);
    grouped.set(row.siteId, current);
  }
  return grouped;
}

export async function getChannelsOverview(): Promise<ChannelsOverviewReadModel> {
  const runtimeHealthSnapshots = await listSiteRuntimeHealthSnapshots();
  const runtimeHealthBySiteId = groupBySiteId(runtimeHealthSnapshots);

  const snapshot = await db.transaction(async (tx: typeof db) => {
    const [siteRows, accountRows, endpointRows, credentialRows] = await Promise.all([
      tx.select().from(schema.sites).orderBy(asc(schema.sites.sortOrder), asc(schema.sites.id)).all(),
      tx.select().from(schema.accounts).orderBy(asc(schema.accounts.sortOrder), asc(schema.accounts.id)).all(),
      tx.select().from(schema.siteApiEndpoints)
        .orderBy(
          asc(schema.siteApiEndpoints.siteId),
          asc(schema.siteApiEndpoints.sortOrder),
          asc(schema.siteApiEndpoints.id),
        )
        .all(),
      tx.select({
        id: schema.credentialVaultItems.id,
        siteId: schema.credentialVaultItems.siteId,
        accountId: schema.credentialVaultItems.accountId,
        name: schema.credentialVaultItems.name,
        kind: schema.credentialVaultItems.kind,
        status: schema.credentialVaultItems.status,
        fingerprint: schema.credentialVaultItems.fingerprint,
        metadata: schema.credentialVaultItems.metadata,
        expiresAt: schema.credentialVaultItems.expiresAt,
        lastUsedAt: schema.credentialVaultItems.lastUsedAt,
        revokedAt: schema.credentialVaultItems.revokedAt,
        version: schema.credentialVaultItems.version,
        createdAt: schema.credentialVaultItems.createdAt,
        updatedAt: schema.credentialVaultItems.updatedAt,
      }).from(schema.credentialVaultItems)
        .orderBy(asc(schema.credentialVaultItems.id))
        .all(),
    ]);

    const ordinaryAccounts = accountRows.filter((account) => !hasOauthProvider(account));
    const oauthAccounts = accountRows.filter((account) => hasOauthProvider(account));
    const connections: ChannelOverviewConnection[] = ordinaryAccounts.map((account) => ({
      id: account.id,
      siteId: account.siteId,
      username: account.username,
      status: account.status,
      credentialMode: resolveCredentialMode(account),
    }));
    const oauthConnections: ChannelOverviewOauthConnection[] = oauthAccounts.flatMap((account) => {
      const oauth = getOauthInfoFromAccount(account);
      if (!oauth?.provider) return [];
      return [{
        accountId: account.id,
        siteId: account.siteId,
        provider: oauth.provider,
        username: account.username,
        email: oauth.email || null,
        status: account.status,
      }];
    });
    const credentials: ChannelOverviewCredential[] = credentialRows.map((credential) => ({
      ...credential,
      metadata: parseCredentialMetadata(credential.metadata),
    }));

    const connectionsBySiteId = groupBySiteId(connections);
    const endpointsBySiteId = groupBySiteId<SiteApiEndpointRow>(
      endpointRows as SiteApiEndpointRow[],
    );
    const credentialsBySiteId = groupBySiteId(
      credentials.filter((credential): credential is ChannelOverviewCredential & { siteId: number } => (
        typeof credential.siteId === 'number'
      )),
    );

    const channels: ChannelOverviewChannel[] = siteRows
      .filter((site) => !isOauthProviderSite(site))
      .map((site) => {
        const siteConnections = connectionsBySiteId.get(site.id) || [];
        const siteCredentials = credentialsBySiteId.get(site.id) || [];
        return {
          id: site.id,
          name: site.name,
          url: site.url,
          homepageUrl: site.homepageUrl,
          platform: site.platform,
          status: site.status,
          isPinned: site.isPinned,
          sortOrder: site.sortOrder,
          globalWeight: site.globalWeight,
          createdAt: site.createdAt,
          updatedAt: site.updatedAt,
          apiEndpoints: (endpointsBySiteId.get(site.id) || []).map((endpoint) => ({
            ...endpoint,
            url: normalizeSiteApiEndpointBaseUrl(endpoint.url),
          })),
          runtimeHealth: runtimeHealthBySiteId.get(site.id) || [],
          connectionCount: siteConnections.length,
          activeConnectionCount: siteConnections.filter((connection) => (
            normalizeStatus(connection.status) === 'active'
          )).length,
          credentialCount: siteCredentials.length,
          activeCredentialCount: siteCredentials.filter((credential) => (
            normalizeStatus(credential.status) === 'active'
          )).length,
        };
      });

    return {
      channels,
      connections,
      oauthConnections,
      credentials,
      totals: {
        sites: channels.length,
        ordinaryConnections: connections.length,
        officialConnections: oauthConnections.length,
        activeCredentials: credentials.filter((credential) => (
          credential.siteId !== null && normalizeStatus(credential.status) === 'active'
        )).length,
      },
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    ...snapshot,
  };
}

export async function getChannelHealthReadModel(input: {
  siteId?: number | null;
  scope?: 'site' | 'model' | null;
  state?: 'healthy' | 'open' | 'recovering' | null;
} = {}): Promise<ChannelHealthReadModel> {
  const items = (await listSiteRuntimeHealthSnapshots()).filter((item) => (
    (input.siteId == null || item.siteId === input.siteId)
    && (input.scope == null || item.scope === input.scope)
    && (input.state == null || item.state === input.state)
  ));
  return {
    generatedAt: new Date().toISOString(),
    total: items.length,
    items,
  };
}
