import { isValidSiteConcurrencyLimit, isValidSiteConcurrencyWait } from '../../shared/siteConcurrency.js';
import { z } from 'zod';

const requiredTrimmedString = z.string().trim().min(1);
const unknownField = z.unknown().optional();

const siteCreatePayloadSchema = z.object({
  name: requiredTrimmedString,
  url: requiredTrimmedString,
  homepageUrl: z.union([z.string(), z.null()]).optional(),
  platform: z.string().trim().optional(),
  initializationPresetId: z.union([z.string(), z.null()]).optional(),
  proxyUrl: unknownField,
  useSystemProxy: unknownField,
  customHeaders: unknownField,
  customHeadersOverrideRequestHeaders: z.boolean().optional(),
  maxConcurrency: z.custom<number | null>(isValidSiteConcurrencyLimit).optional(),
  concurrencyWaitTimeoutMs: z.custom<number>(isValidSiteConcurrencyWait).optional(),
  codexFingerprintEnabled: unknownField,
  externalCheckinUrl: unknownField,
  status: unknownField,
  isPinned: unknownField,
  sortOrder: unknownField,
  globalWeight: unknownField,
}).passthrough();

const siteUpdatePayloadSchema = z.object({
  name: requiredTrimmedString.optional(),
  url: requiredTrimmedString.optional(),
  homepageUrl: z.union([z.string(), z.null()]).optional(),
  platform: requiredTrimmedString.optional(),
  proxyUrl: unknownField,
  useSystemProxy: unknownField,
  customHeaders: unknownField,
  customHeadersOverrideRequestHeaders: z.boolean().optional(),
  maxConcurrency: z.custom<number | null>(isValidSiteConcurrencyLimit).optional(),
  concurrencyWaitTimeoutMs: z.custom<number>(isValidSiteConcurrencyWait).optional(),
  codexFingerprintEnabled: unknownField,
  externalCheckinUrl: unknownField,
  status: unknownField,
  isPinned: unknownField,
  sortOrder: unknownField,
  globalWeight: unknownField,
}).passthrough();

const siteBatchPayloadSchema = z.object({
  ids: z.array(z.number().int().positive()).optional(),
  action: z.string().optional(),
}).passthrough();

const siteDisabledModelsPayloadSchema = z.object({
  models: z.array(z.string()).optional(),
}).passthrough();

const siteDetectPayloadSchema = z.object({
  url: requiredTrimmedString,
}).passthrough();

export type SiteBatchPayload = z.output<typeof siteBatchPayloadSchema>;
export type SiteCreatePayload = z.output<typeof siteCreatePayloadSchema>;
export type SiteDetectPayload = z.output<typeof siteDetectPayloadSchema>;
export type SiteDisabledModelsPayload = z.output<typeof siteDisabledModelsPayloadSchema>;
export type SiteUpdatePayload = z.output<typeof siteUpdatePayloadSchema>;

function normalizeSitePayloadInput(input: unknown): unknown {
  if (input === undefined) return {};
  if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  return null;
}

function formatSitePayloadError(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  const firstPath = firstIssue?.path[0];
  if (firstPath === 'maxConcurrency') return 'Invalid maxConcurrency. Expected null or an integer from 1 to 10000.';
  if (firstPath === 'concurrencyWaitTimeoutMs') return 'Invalid concurrencyWaitTimeoutMs. Expected an integer from 0 to 60000.';
  if (firstPath === 'name') {
    return 'Invalid name. Expected non-empty string.';
  }
  if (firstPath === 'url') {
    return 'Invalid url. Expected non-empty string.';
  }
  if (firstPath === 'homepageUrl') {
    return 'Invalid homepageUrl. Expected string or null.';
  }
  if (firstPath === 'platform') {
    return 'Invalid platform. Expected string.';
  }
  if (firstPath === 'ids') {
    return 'Invalid ids. Expected number[].';
  }
  if (firstPath === 'action') {
    return 'Invalid action. Expected string.';
  }
  if (firstPath === 'models') {
    return 'Invalid models. Expected string[].';
  }
  return 'Invalid site payload.';
}

export function parseSiteCreatePayload(input: unknown):
{ success: true; data: SiteCreatePayload } | { success: false; error: string } {
  const result = siteCreatePayloadSchema.safeParse(normalizeSitePayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSitePayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}

export function parseSiteUpdatePayload(input: unknown):
{ success: true; data: SiteUpdatePayload } | { success: false; error: string } {
  const result = siteUpdatePayloadSchema.safeParse(normalizeSitePayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSitePayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}

export function parseSiteBatchPayload(input: unknown):
{ success: true; data: SiteBatchPayload } | { success: false; error: string } {
  const result = siteBatchPayloadSchema.safeParse(normalizeSitePayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSitePayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}

export function parseSiteDisabledModelsPayload(input: unknown):
{ success: true; data: SiteDisabledModelsPayload } | { success: false; error: string } {
  const result = siteDisabledModelsPayloadSchema.safeParse(normalizeSitePayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSitePayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}

export function parseSiteDetectPayload(input: unknown):
{ success: true; data: SiteDetectPayload } | { success: false; error: string } {
  const result = siteDetectPayloadSchema.safeParse(normalizeSitePayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSitePayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}
