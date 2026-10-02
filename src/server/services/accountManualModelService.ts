import { and, eq, inArray } from 'drizzle-orm';
import { db, runtimeDbDialect, schema } from '../db/index.js';
import * as routeRefreshWorkflow from './routeRefreshWorkflow.js';

export class AccountManualModelServiceError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'AccountManualModelServiceError';
  }
}

function normalizeManualModelNames(accountId: number, modelNames: string[]): string[] {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new AccountManualModelServiceError('账号 ID 无效', 400);
  }
  const names = Array.from(new Set(modelNames.map((name) => name.trim()).filter(Boolean)));
  if (names.length === 0) {
    throw new AccountManualModelServiceError('模型列表不能为空', 400);
  }
  return names;
}

export async function addManualModelsToAccount(accountId: number, modelNames: string[]): Promise<void> {
  const names = normalizeManualModelNames(accountId, modelNames);
  await db.transaction(async (tx) => {
    const account = await tx.select({ id: schema.accounts.id }).from(schema.accounts)
      .where(eq(schema.accounts.id, accountId)).get();
    if (!account) throw new AccountManualModelServiceError('账号不存在', 404);

    const checkedAt = new Date().toISOString();
    const updates = { available: true, isManual: true, latencyMs: null, checkedAt };
    for (const modelName of names) {
      const insert = tx.insert(schema.modelAvailability)
        .values({ accountId, modelName, ...updates }) as any;
      if (runtimeDbDialect === 'mysql') {
        await insert.onDuplicateKeyUpdate({ set: updates }).run();
      } else {
        await insert.onConflictDoUpdate({
          target: [schema.modelAvailability.accountId, schema.modelAvailability.modelName],
          set: updates,
        }).run();
      }
    }
  });
  await routeRefreshWorkflow.rebuildRoutesBestEffort();
}

export async function removeManualModelsFromAccount(
  accountId: number,
  modelNames: string[],
): Promise<{ deletedCount: number; rebuiltRoutes: boolean }> {
  const names = normalizeManualModelNames(accountId, modelNames);
  const deletedCount = await db.transaction(async (tx) => {
    const account = await tx.select({ id: schema.accounts.id }).from(schema.accounts)
      .where(eq(schema.accounts.id, accountId)).get();
    if (!account) throw new AccountManualModelServiceError('账号不存在', 404);

    const result = await tx.delete(schema.modelAvailability).where(and(
      eq(schema.modelAvailability.accountId, accountId),
      eq(schema.modelAvailability.isManual, true),
      inArray(schema.modelAvailability.modelName, names),
    )).run();
    return result.changes ?? 0;
  });

  const rebuiltRoutes = deletedCount > 0
    ? await routeRefreshWorkflow.rebuildRoutesBestEffort()
    : true;
  return { deletedCount, rebuiltRoutes };
}
