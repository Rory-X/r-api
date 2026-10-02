import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { recordAlertOccurrence } from './alertIncidentService.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { appendSessionTokenRebindHint } from './alertRules.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

export async function reportTokenExpired(params: {
  accountId: number;
  username?: string | null;
  siteName?: string | null;
  detail?: string;
}) {
  const accountLabel = params.username || `ID:${params.accountId}`;
  const siteLabel = params.siteName || 'unknown-site';
  const detailText = params.detail ? appendSessionTokenRebindHint(params.detail) : '';
  const detail = detailText ? ` (${detailText})` : '';
  const createdAt = formatUtcSqlDateTime(new Date());

  await db.insert(schema.events).values({
    type: 'token',
    title: 'Token 已失效',
    message: `${accountLabel} @ ${siteLabel} 的 Token 无效或已过期${detail}`,
    level: 'error',
    relatedId: params.accountId,
    relatedType: 'account',
    createdAt,
  }).run();

  await db.update(schema.accounts).set({
    status: 'expired',
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.accounts.id, params.accountId)).run();

  setAccountRuntimeHealth(params.accountId, {
    state: 'unhealthy',
    reason: detailText ? `访问令牌失效：${detailText}` : '访问令牌失效',
    source: 'auth',
  });

  await recordAlertOccurrence({
    ruleKey: 'token_expired',
    fingerprint: `account:${params.accountId}`,
    severity: 'error',
    title: 'Token 已失效',
    message: `${accountLabel} @ ${siteLabel} 的 Token 无效或已过期${detail}`,
    entityType: 'account',
    entityId: params.accountId,
    value: { accountId: params.accountId, siteName: siteLabel },
  });
}

export async function reportProxyAllFailed(params: { model: string; reason: string }) {
  const createdAt = formatUtcSqlDateTime(new Date());
  await db.insert(schema.events).values({
    type: 'proxy',
    title: '代理全部失败',
    message: `模型=${params.model}, 原因=${params.reason}`,
    level: 'error',
    relatedType: 'route',
    createdAt,
  }).run();

  await recordAlertOccurrence({
    ruleKey: 'proxy_all_failed',
    fingerprint: `model:${params.model}`,
    severity: 'error',
    title: '代理全部失败',
    message: `模型=${params.model}, 原因=${params.reason}`,
    entityType: 'model',
    entityId: params.model,
    value: { model: params.model, reason: params.reason },
  });
}
