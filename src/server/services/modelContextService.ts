import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { readModelContextEvidence } from '../contracts/modelDiscovery.js';

export type ModelContextRef = { accountId: number; tokenId?: number | null; modelName: string };

export async function getKnownModelContextLength(refs: ModelContextRef[]): Promise<number | undefined> {
  if (refs.length === 0) return undefined;
  const limits = await Promise.all(refs.map(async (ref) => {
    const name = ref.modelName.trim().toLowerCase();
    const rows = ref.tokenId
      ? await db.select({
        available: schema.tokenModelAvailability.available,
        contextLength: schema.tokenModelAvailability.contextLength,
        contextSource: schema.tokenModelAvailability.contextSource,
        contextUpdatedAt: schema.tokenModelAvailability.contextUpdatedAt,
      }).from(schema.tokenModelAvailability)
        .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
        .where(and(eq(schema.tokenModelAvailability.tokenId, ref.tokenId), eq(schema.accountTokens.accountId, ref.accountId),
          sql`lower(${schema.tokenModelAvailability.modelName}) = ${name}`)).all()
      : await db.select().from(schema.modelAvailability)
        .where(and(eq(schema.modelAvailability.accountId, ref.accountId), sql`lower(${schema.modelAvailability.modelName}) = ${name}`)).all();
    if (rows.length === 0) return undefined;
    const values = rows.map((row) => row.available !== false ? readModelContextEvidence(row)?.contextLength : undefined);
    return values.some((value) => value === undefined) ? undefined : Math.min(...values as number[]);
  }));
  return limits.some((value) => value === undefined) ? undefined : Math.min(...limits as number[]);
}
