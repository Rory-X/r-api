import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { refreshBalance } from "../../services/balanceService.js";
import { getAdapter } from "../../services/platforms/index.js";
import {
  convergeAccountMutation,
  rebuildRoutesBestEffort,
} from "../../services/accountMutationWorkflow.js";
import {
  getCredentialModeFromExtraConfig,
  getProxyUrlFromExtraConfig,
  guessPlatformUserIdFromUsername,
  hasOauthProvider,
  getSub2ApiAuthFromExtraConfig,
  mergeAccountExtraConfig,
  normalizeCredentialMode as normalizeCredentialModeInput,
  resolvePlatformUserId,
  type AccountCredentialMode,
} from "../../services/accountExtraConfig.js";
import { loginAndPersistAccount } from "../../services/accountLoginService.js";
import {
  AccountSessionRebindError,
  rebindSessionAccount,
} from "../../services/accountSessionRebindService.js";
import { applyAccountUpdateWorkflow } from "../../services/accountUpdateWorkflow.js";
import { startBackgroundTask } from "../../services/backgroundTaskService.js";
import { parseCheckinRewardAmount } from "../../services/checkinRewardParser.js";
import { estimateRewardWithTodayIncomeFallback } from "../../services/todayIncomeRewardService.js";
import { getLocalDayRangeUtc } from "../../services/localTimeService.js";
import {
  buildRuntimeHealthForAccount,
  setAccountRuntimeHealth,
  type RuntimeHealthState,
} from "../../services/accountHealthService.js";
import { appendSessionTokenRebindHint } from "../../services/alertRules.js";
import {
  parseSiteProxyUrlInput,
  withAccountProxyOverride,
  withSiteRecordProxyRequestInit,
} from "../../services/siteProxy.js";
import { createRateLimitGuard } from "../../middleware/requestRateLimit.js";
import { getAccountsSnapshot } from "../../services/accountsOverviewService.js";
import {
  type AccountCreatePayload,
  parseAccountBatchPayload,
  parseAccountCreatePayload,
  parseAccountHealthRefreshPayload,
  parseAccountLoginPayload,
  parseAccountManualModelsPayload,
  parseAccountRebindSessionPayload,
  parseAccountUpdatePayload,
  parseAccountVerifyTokenPayload,
} from "../../contracts/accountsRoutePayloads.js";
import {
  requireSiteApiBaseUrl,
  runWithSiteApiEndpointPool,
} from "../../services/siteApiEndpointService.js";
import {
  buildBatchApiKeyConnectionName,
  parseBatchApiKeys,
} from "../../services/apiKeyBatch.js";
import { createManualAccount } from "../../services/manualAccountCreationService.js";
import {
  AccountManualModelServiceError,
  addManualModelsToAccount,
  removeManualModelsFromAccount,
} from "../../services/accountManualModelService.js";

type AccountWithSiteRow = {
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
};

type AccountHealthRefreshResult = {
  accountId: number;
  username: string | null;
  siteName: string;
  status: "success" | "failed" | "skipped";
  state: RuntimeHealthState;
  message: string;
};

type AccountCapabilities = {
  canCheckin: boolean;
  canRefreshBalance: boolean;
  proxyOnly: boolean;
};

type VerifyFailureReason =
  | "needs-user-id"
  | "invalid-user-id"
  | "shield-blocked"
  | null;

const limitAccountLogin = createRateLimitGuard({
  bucket: "accounts-login",
  max: 5,
  windowMs: 60_000,
});

const limitAccountVerifyToken = createRateLimitGuard({
  bucket: "accounts-verify-token",
  max: 5,
  windowMs: 60_000,
});

function parseBooleanFlag(raw?: string): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function hasSessionTokenValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveRequestedCredentialMode(input: unknown): AccountCredentialMode {
  return normalizeCredentialModeInput(input) || "auto";
}

function resolveStoredCredentialMode(
  account: typeof schema.accounts.$inferSelect,
): AccountCredentialMode {
  const fromConfig = getCredentialModeFromExtraConfig(account.extraConfig);
  if (fromConfig && fromConfig !== "auto") return fromConfig;
  return hasSessionTokenValue(account.accessToken) ? "session" : "apikey";
}

function buildCapabilitiesFromCredentialMode(
  credentialMode: AccountCredentialMode,
  hasSessionToken: boolean,
  oauthIdentity?:
    | string
    | null
    | Pick<
        typeof schema.accounts.$inferSelect,
        "extraConfig" | "oauthProvider"
      >,
): AccountCapabilities {
  if (hasOauthProvider(oauthIdentity)) {
    return {
      canCheckin: false,
      canRefreshBalance: false,
      proxyOnly: true,
    };
  }
  const sessionCapable =
    credentialMode === "session"
      ? hasSessionToken
      : credentialMode === "apikey"
        ? false
        : hasSessionToken;
  return {
    canCheckin: sessionCapable,
    canRefreshBalance: sessionCapable,
    proxyOnly: !sessionCapable,
  };
}

function buildCapabilitiesForAccount(
  account: typeof schema.accounts.$inferSelect,
): AccountCapabilities {
  const credentialMode = resolveStoredCredentialMode(account);
  return buildCapabilitiesFromCredentialMode(
    credentialMode,
    hasSessionTokenValue(account.accessToken),
    account,
  );
}

function normalizeBatchIds(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => Number.parseInt(String(item), 10))
    .filter((id) => Number.isFinite(id) && id > 0);
}

function normalizePinnedFlag(input: unknown): boolean | null {
  if (input === undefined || input === null) return null;
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return input !== 0;
  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return null;
}

function resolveRequestedCreateTokens(
  body: AccountCreatePayload,
  credentialMode: AccountCredentialMode,
): string[] {
  if (credentialMode !== "apikey") {
    const single = String(body.accessToken || "").trim();
    return single ? [single] : [];
  }

  const batchTokens = parseBatchApiKeys(body.accessTokens);
  if (batchTokens.length > 0) return batchTokens;
  return parseBatchApiKeys(body.accessToken);
}

function normalizeSortOrder(input: unknown): number | null {
  if (input === undefined || input === null || input === "") return null;
  const parsed = Number.parseInt(String(input), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, parsed);
}

function normalizeManagedRefreshToken(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeManagedTokenExpiresAt(input: unknown): number | undefined {
  if (typeof input === "number" && Number.isFinite(input) && input > 0)
    return Math.trunc(input);
  if (typeof input === "string") {
    const parsed = Number.parseInt(input.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

const ACCOUNT_HEALTH_REFRESH_TIMEOUT_MS = 10_000;
const ACCOUNT_VERIFY_TIMEOUT_MS = 10_000;
const ACCOUNT_VERIFY_DIAG_TIMEOUT_MS = 2_500;

function summarizeAccountHealthRefresh(results: AccountHealthRefreshResult[]) {
  return {
    total: results.length,
    healthy: results.filter((item) => item.state === "healthy").length,
    unhealthy: results.filter((item) => item.state === "unhealthy").length,
    degraded: results.filter((item) => item.state === "degraded").length,
    disabled: results.filter((item) => item.state === "disabled").length,
    unknown: results.filter((item) => item.state === "unknown").length,
    success: results.filter((item) => item.status === "success").length,
    failed: results.filter((item) => item.status === "failed").length,
    skipped: results.filter((item) => item.status === "skipped").length,
  };
}

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isVerificationTimeoutError(error: unknown): boolean {
  const name =
    typeof error === "object" && error && "name" in error
      ? String((error as { name?: unknown }).name || "")
      : "";
  const message =
    typeof error === "object" && error && "message" in error
      ? String((error as { message?: unknown }).message || "")
      : String(error || "");
  const lowered = `${name} ${message}`.toLowerCase();
  return (
    lowered.includes("timeout") ||
    lowered.includes("timed out") ||
    lowered.includes("abort")
  );
}

function buildAccountVerifyTimeoutMessage(): string {
  return `Token verification timed out (${Math.max(1, Math.round(ACCOUNT_VERIFY_TIMEOUT_MS / 1000))}s)`;
}

async function getModelsWithSiteApiEndpointPool(
  site: typeof schema.sites.$inferSelect,
  adapter: NonNullable<ReturnType<typeof getAdapter>>,
  accessToken: string,
  platformUserId?: number,
): Promise<string[]> {
  const timeoutMessage = buildAccountVerifyTimeoutMessage();
  const deadline = Date.now() + ACCOUNT_VERIFY_TIMEOUT_MS;
  return runWithSiteApiEndpointPool(site, (target) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(timeoutMessage);
    }
    return withTimeout(
      () => adapter.getModels(target.baseUrl, accessToken, platformUserId),
      remainingMs,
      timeoutMessage,
    );
  });
}

function resolveUserIdFailureReason(
  message: string,
  hasProvidedUserId: boolean,
): VerifyFailureReason {
  const lowered = String(message || "")
    .trim()
    .toLowerCase();
  if (!lowered) return null;

  if (
    lowered.includes("mismatch") ||
    lowered.includes("not match") ||
    lowered.includes("invalid user id") ||
    lowered.includes("wrong user id")
  ) {
    return "invalid-user-id";
  }

  if (
    lowered.includes("missing new-api-user") ||
    lowered.includes("new-api-user required") ||
    lowered.includes("requires user id") ||
    lowered.includes("missing user id")
  ) {
    return "needs-user-id";
  }

  if (lowered.includes("new-api-user") || lowered.includes("user id")) {
    return hasProvidedUserId ? "invalid-user-id" : "needs-user-id";
  }

  return null;
}

async function refreshRuntimeHealthForRow(
  row: AccountWithSiteRow,
): Promise<AccountHealthRefreshResult> {
  const accountId = row.accounts.id;
  const username = row.accounts.username;
  const siteName = row.sites.name;
  const capabilities = buildCapabilitiesForAccount(row.accounts);

  if (
    (row.accounts.status || "active") === "disabled" ||
    (row.sites.status || "active") === "disabled"
  ) {
    setAccountRuntimeHealth(accountId, {
      state: "disabled",
      reason: "账号或站点已禁用",
      source: "health-refresh",
    });
    return {
      accountId,
      username,
      siteName,
      status: "skipped",
      state: "disabled",
      message: "账号或站点已禁用",
    };
  }

  if (capabilities.proxyOnly) {
    return {
      accountId,
      username,
      siteName,
      status: "skipped",
      state: "unknown",
      message: "仅代理账号不支持会话健康检查",
    };
  }

  try {
    await withTimeout(
      () => refreshBalance(accountId),
      ACCOUNT_HEALTH_REFRESH_TIMEOUT_MS,
      `站点健康检查超时（${Math.max(1, Math.round(ACCOUNT_HEALTH_REFRESH_TIMEOUT_MS / 1000))}s）`,
    );
    const refreshedAccount = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();
    const runtimeHealth = buildRuntimeHealthForAccount({
      accountStatus: refreshedAccount?.status || row.accounts.status,
      siteStatus: row.sites.status,
      extraConfig: refreshedAccount?.extraConfig ?? row.accounts.extraConfig,
      sessionCapable: capabilities.canRefreshBalance,
    });

    return {
      accountId,
      username,
      siteName,
      status: runtimeHealth.state === "unhealthy" ? "failed" : "success",
      state: runtimeHealth.state,
      message: runtimeHealth.reason,
    };
  } catch (error: any) {
    const message = String(error?.message || "健康检查失败");
    setAccountRuntimeHealth(accountId, {
      state: "unhealthy",
      reason: message,
      source: "health-refresh",
    });
    return {
      accountId,
      username,
      siteName,
      status: "failed",
      state: "unhealthy",
      message,
    };
  }
}

async function executeRefreshAccountRuntimeHealth(accountId?: number) {
  const rows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();

  const targetRows = Number.isFinite(accountId as number)
    ? rows.filter((row) => row.accounts.id === accountId)
    : rows;

  const results: AccountHealthRefreshResult[] = [];
  for (const row of targetRows) {
    results.push(await refreshRuntimeHealthForRow(row));
  }

  return {
    summary: summarizeAccountHealthRefresh(results),
    results,
  };
}

export async function accountsRoutes(app: FastifyInstance) {
  // List all accounts (with site info)
  app.get<{ Querystring: { refresh?: string } }>(
    "/api/accounts",
    async (request, reply) => {
      const snapshot = await getAccountsSnapshot({
        forceRefresh: parseBooleanFlag(request.query.refresh),
      });
      reply.header("x-accounts-snapshot-cache", snapshot.cacheStatus);
      return {
        generatedAt: snapshot.generatedAt,
        accounts: snapshot.payload.accounts,
        sites: snapshot.payload.sites,
      };
    },
  );

  // Login to a site and auto-create account
  app.post<{ Body: unknown }>(
    "/api/accounts/login",
    { preHandler: [limitAccountLogin] },
    async (request, reply) => {
      const parsedBody = parseAccountLoginPayload(request.body);
      if (!parsedBody.success) {
        return reply
          .code(400)
          .send({ success: false, message: parsedBody.error });
      }

      return await loginAndPersistAccount(parsedBody.data);
    },
  );

  // Verify credentials against a site.
  app.post<{ Body: unknown }>(
    "/api/accounts/verify-token",
    { preHandler: [limitAccountVerifyToken] },
    async (request, reply) => {
      const parsedBody = parseAccountVerifyTokenPayload(request.body);
      if (!parsedBody.success) {
        return reply
          .code(400)
          .send({ success: false, message: parsedBody.error });
      }

      const { siteId, platformUserId } = parsedBody.data;
      const accessToken = (parsedBody.data.accessToken || "").trim();
      const credentialMode = resolveRequestedCredentialMode(
        parsedBody.data.credentialMode,
      );
      const site = await db
        .select()
        .from(schema.sites)
        .where(eq(schema.sites.id, siteId))
        .get();
      if (!site) return { success: false, message: "site not found" };

      if (!accessToken) {
        return { success: false, message: "Token 不能为空" };
      }

      const adapter = getAdapter(site.platform);
      if (!adapter)
        return { success: false, message: `不支持的平台: ${site.platform}` };

      const normalizedPlatform = String(
        adapter.platformName || site.platform || "",
      )
        .trim()
        .toLowerCase();
      const parsedPlatformUserId =
        typeof platformUserId === "number" &&
        Number.isFinite(platformUserId) &&
        platformUserId > 0
          ? Math.trunc(platformUserId)
          : undefined;
      const hasProvidedUserId = parsedPlatformUserId !== undefined;
      const skipRawShieldDetection =
        normalizedPlatform === "new-api" || normalizedPlatform === "anyrouter";
      const diagnoseVerificationFailure = async (
        options: { useApiEndpointPool?: boolean } = {},
      ): Promise<VerifyFailureReason> => {
        const parseFailureReason = (
          bodyText: string,
          contentType: string,
        ): VerifyFailureReason => {
          const text = bodyText || "";
          const ct = (contentType || "").toLowerCase();
          if (
            !skipRawShieldDetection &&
            ct.includes("text/html") &&
            /var\s+arg1\s*=|acw_sc__v2|cdn_sec_tc|<script/i.test(text)
          ) {
            return "shield-blocked";
          }

          try {
            const body = JSON.parse(text) as any;
            const message =
              typeof body?.message === "string" ? body.message : "";
            const userIdReason = resolveUserIdFailureReason(
              message,
              hasProvidedUserId,
            );
            if (userIdReason) return userIdReason;
            if (
              !skipRawShieldDetection &&
              /shield|challenge|captcha|acw_sc__v2|arg1/i.test(message)
            ) {
              return "shield-blocked";
            }
          } catch {}

          return null;
        };

        try {
          const { fetch } = await import("undici");
          const candidates = new Set<string>();
          const raw = accessToken.startsWith("Bearer ")
            ? accessToken.slice(7).trim()
            : accessToken;
          if (raw) {
            if (raw.includes("=")) candidates.add(raw);
            candidates.add(`session=${raw}`);
            candidates.add(`token=${raw}`);
          }

          const diagnosticUserId = hasProvidedUserId
            ? String(parsedPlatformUserId)
            : "0";
          const headerVariants: Record<string, string>[] = [
            {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              "New-Api-User": diagnosticUserId,
            },
          ];

          for (const cookie of candidates) {
            headerVariants.push({
              Cookie: cookie,
              "Content-Type": "application/json",
              "X-Requested-With": "XMLHttpRequest",
              ...(hasProvidedUserId
                ? { "New-Api-User": diagnosticUserId }
                : {}),
            });
          }

          const tryBaseUrl = async (
            baseUrl: string,
          ): Promise<VerifyFailureReason> => {
            let sawNetworkError = false;
            let sawResponse = false;
            for (const headers of headerVariants) {
              try {
                const testRes = await fetch(
                  `${baseUrl.replace(/\/+$/, "")}/api/user/self`,
                  withSiteRecordProxyRequestInit(site, {
                    headers,
                    signal: AbortSignal.timeout(ACCOUNT_VERIFY_DIAG_TIMEOUT_MS),
                  }),
                );
                sawResponse = true;
                const bodyText = await testRes.text();
                const contentType = testRes.headers.get("content-type") || "";
                const reason = parseFailureReason(bodyText, contentType);
                if (reason) return reason;
              } catch {
                sawNetworkError = true;
              }
            }
            if (sawNetworkError && !sawResponse) {
              throw new Error(`diagnostic request timed out for ${baseUrl}`);
            }
            return null;
          };

          if (options.useApiEndpointPool) {
            const diagnosticBaseUrl = await requireSiteApiBaseUrl(site);
            return await tryBaseUrl(diagnosticBaseUrl);
          }

          return await tryBaseUrl(site.url);
        } catch {}

        return null;
      };
      const buildVerificationFailureResponse = (
        failureReason: VerifyFailureReason,
      ) => {
        if (failureReason === "needs-user-id") {
          return {
            success: false,
            needsUserId: true,
            message:
              "This site requires a user ID. Please fill in your site user ID.",
          };
        }

        if (failureReason === "invalid-user-id") {
          return {
            success: false,
            invalidUserId: true,
            message:
              "The provided user ID does not match this token. Please check your site user ID.",
          };
        }

        if (failureReason === "shield-blocked") {
          return {
            success: false,
            shieldBlocked: true,
            message:
              "This site is shielded by anti-bot challenge. Create an API key on the target site and import that key.",
          };
        }

        return null;
      };

      if (
        !hasProvidedUserId &&
        (normalizedPlatform === "new-api" || normalizedPlatform === "anyrouter")
      ) {
        const preflightReason = await diagnoseVerificationFailure({
          useApiEndpointPool: credentialMode === "apikey",
        });
        if (preflightReason === "needs-user-id") {
          return buildVerificationFailureResponse(preflightReason);
        }
      }

      if (credentialMode === "apikey") {
        try {
          const models = await getModelsWithSiteApiEndpointPool(
            site,
            adapter,
            accessToken,
            parsedPlatformUserId,
          );
          const availableModels = Array.isArray(models)
            ? models.filter(
                (item) => typeof item === "string" && item.trim().length > 0,
              )
            : [];
          if (availableModels.length === 0) {
            return {
              success: false,
              message: "API Key 验证失败：未获取到可用模型",
            };
          }
          return {
            success: true,
            tokenType: "apikey",
            modelCount: availableModels.length,
            models: availableModels.slice(0, 10),
          };
        } catch (err: any) {
          if (isVerificationTimeoutError(err)) {
            const failure = buildVerificationFailureResponse(
              await diagnoseVerificationFailure({
                useApiEndpointPool: true,
              }),
            );
            if (failure) return failure;
          }
          return {
            success: false,
            message: err?.message || "API Key 验证失败",
          };
        }
      }

      let result: any;
      try {
        result = await withTimeout(
          () =>
            adapter.verifyToken(site.url, accessToken, parsedPlatformUserId),
          ACCOUNT_VERIFY_TIMEOUT_MS,
          `Token verification timed out (${Math.max(1, Math.round(ACCOUNT_VERIFY_TIMEOUT_MS / 1000))}s)`,
        );
      } catch (err: any) {
        if (isVerificationTimeoutError(err)) {
          const failure = buildVerificationFailureResponse(
            await diagnoseVerificationFailure(),
          );
          if (failure) return failure;
        }
        return {
          success: false,
          message: appendSessionTokenRebindHint(
            err?.message || "Token 验证失败",
          ),
        };
      }

      if (result.tokenType === "session") {
        return {
          success: true,
          tokenType: "session",
          userInfo: result.userInfo,
          balance: result.balance,
          apiToken: result.apiToken,
        };
      }

      if (result.tokenType === "apikey") {
        if (credentialMode === "session") {
          return {
            success: false,
            message:
              "当前凭证是 API Key，请切换到 API Key 模式，或改用 Session Token",
          };
        }
        return {
          success: true,
          tokenType: "apikey",
          modelCount: result.models?.length || 0,
          models: result.models?.slice(0, 10),
        };
      }

      // Try to explain unknown failures: missing user id vs anti-bot challenge page.
      const detectVerifyFailureReason =
        async (): Promise<VerifyFailureReason> => {
          const parseFailureReason = (
            bodyText: string,
            contentType: string,
          ): VerifyFailureReason => {
            const text = bodyText || "";
            const ct = (contentType || "").toLowerCase();
            if (
              !skipRawShieldDetection &&
              ct.includes("text/html") &&
              /var\s+arg1\s*=|acw_sc__v2|cdn_sec_tc|<script/i.test(text)
            ) {
              return "shield-blocked";
            }

            try {
              const body = JSON.parse(text) as any;
              const message =
                typeof body?.message === "string" ? body.message : "";
              const userIdReason = resolveUserIdFailureReason(
                message,
                hasProvidedUserId,
              );
              if (userIdReason) return userIdReason;
              if (
                !skipRawShieldDetection &&
                /shield|challenge|captcha|acw_sc__v2|arg1/i.test(message)
              ) {
                return "shield-blocked";
              }
            } catch {}

            return null;
          };

          try {
            const { fetch } = await import("undici");
            const candidates = new Set<string>();
            const raw = accessToken.startsWith("Bearer ")
              ? accessToken.slice(7).trim()
              : accessToken;
            if (raw) {
              if (raw.includes("=")) candidates.add(raw);
              candidates.add(`session=${raw}`);
              candidates.add(`token=${raw}`);
            }

            const diagnosticUserId = hasProvidedUserId
              ? String(parsedPlatformUserId)
              : "0";
            const headerVariants: Record<string, string>[] = [
              {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "New-Api-User": diagnosticUserId,
              },
            ];

            for (const cookie of candidates) {
              headerVariants.push({
                Cookie: cookie,
                "Content-Type": "application/json",
                "X-Requested-With": "XMLHttpRequest",
                ...(hasProvidedUserId
                  ? { "New-Api-User": diagnosticUserId }
                  : {}),
              });
            }

            for (const headers of headerVariants) {
              try {
                const testRes = await fetch(
                  `${site.url}/api/user/self`,
                  withSiteRecordProxyRequestInit(site, {
                    headers,
                    signal: AbortSignal.timeout(ACCOUNT_VERIFY_DIAG_TIMEOUT_MS),
                  }),
                );
                const bodyText = await testRes.text();
                const contentType = testRes.headers.get("content-type") || "";
                const reason = parseFailureReason(bodyText, contentType);
                if (reason) return reason;
              } catch {}
            }
          } catch {}

          return null;
        };

      const failureReason = await detectVerifyFailureReason();
      if (failureReason === "needs-user-id") {
        return {
          success: false,
          needsUserId: true,
          message:
            "This site requires a user ID. Please fill in your site user ID.",
        };
      }

      if (failureReason === "invalid-user-id") {
        return {
          success: false,
          invalidUserId: true,
          message:
            "The provided user ID does not match this token. Please check your site user ID.",
        };
      }

      if (failureReason === "shield-blocked") {
        return {
          success: false,
          shieldBlocked: true,
          message:
            "This site is shielded by anti-bot challenge. Create an API key on the target site and import that key.",
        };
      }

      return {
        success: false,
        message:
          credentialMode === "session"
            ? "Session Token 验证失败"
            : "Token invalid: cannot use it as session cookie or API key",
      };
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/accounts/:id/rebind-session",
    async (request, reply) => {
      const parsedBody = parseAccountRebindSessionPayload(request.body);
      if (!parsedBody.success) {
        return reply
          .code(400)
          .send({ success: false, message: parsedBody.error });
      }

      const accountId = Number.parseInt(request.params.id, 10);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return reply
          .code(400)
          .send({ success: false, message: "账号 ID 无效" });
      }

      try {
        const result = await rebindSessionAccount({
          accountId,
          accessToken: parsedBody.data.accessToken || "",
          platformUserId: parsedBody.data.platformUserId,
          refreshToken: parsedBody.data.refreshToken,
          tokenExpiresAt: parsedBody.data.tokenExpiresAt,
        });
        return {
          success: true,
          ...result,
          capabilities: result.account
            ? buildCapabilitiesForAccount(result.account)
            : buildCapabilitiesFromCredentialMode("session", true, null),
        };
      } catch (error) {
        const statusCode = error instanceof AccountSessionRebindError
          ? error.statusCode
          : 400;
        return reply.code(statusCode).send({
          success: false,
          message: error instanceof Error ? error.message : "Token 验证失败",
        });
      }
    },
  );

  // Add an account (manual credential input)
  app.post<{ Body: unknown }>("/api/accounts", async (request, reply) => {
    const parsedBody = parseAccountCreatePayload(request.body);
    if (!parsedBody.success) {
      return reply
        .code(400)
        .send({ success: false, message: parsedBody.error });
    }

    const body = parsedBody.data;
    const site = await db
      .select()
      .from(schema.sites)
      .where(eq(schema.sites.id, body.siteId))
      .get();
    if (!site) {
      return reply
        .code(400)
        .send({ success: false, message: "site not found" });
    }

    const adapter = getAdapter(site.platform);
    if (!adapter) {
      return reply
        .code(400)
        .send({
          success: false,
          message: `platform not supported: ${site.platform}`,
        });
    }

    const explicitBatchTokens = parseBatchApiKeys(body.accessTokens);
    const credentialMode =
      explicitBatchTokens.length > 0
        ? "apikey"
        : resolveRequestedCredentialMode(body.credentialMode);
    const requestedTokens =
      explicitBatchTokens.length > 0
        ? explicitBatchTokens
        : resolveRequestedCreateTokens(body, credentialMode);
    if (requestedTokens.length === 0) {
      return reply.code(400).send({ success: false, message: "请填写 Token" });
    }

    if (credentialMode === "apikey" && requestedTokens.length > 1) {
      const items: Array<Record<string, unknown>> = [];
      let createdCount = 0;

      for (const [index, token] of requestedTokens.entries()) {
        try {
          const created = await createManualAccount({
            body,
            site,
            adapter,
            credentialMode,
            rawAccessToken: token,
            usernameOverride:
              buildBatchApiKeyConnectionName(
                body.username,
                index,
                requestedTokens.length,
              ) || undefined,
          });
          createdCount += 1;
          items.push({
            index,
            status: "created",
            id: created.account.id,
            username: created.account.username || null,
            queued: created.queued === true,
            message: created.message || null,
            modelCount: created.modelCount || 0,
          });
        } catch (error: any) {
          items.push({
            index,
            status: "failed",
            message: error?.message || "创建失败",
            requiresVerification: error?.requiresVerification === true,
          });
        }
      }

      if (createdCount === 0) {
        return reply.code(400).send({
          success: false,
          batch: true,
          totalCount: requestedTokens.length,
          createdCount: 0,
          failedCount: requestedTokens.length,
          message: `批量添加失败（0/${requestedTokens.length}）`,
          items,
        });
      }

      return {
        success: true,
        batch: true,
        totalCount: requestedTokens.length,
        createdCount,
        failedCount: requestedTokens.length - createdCount,
        message: `批量添加完成：成功 ${createdCount}，失败 ${requestedTokens.length - createdCount}`,
        items,
      };
    }

    try {
      const created = await createManualAccount({
        body,
        site,
        adapter,
        credentialMode,
        rawAccessToken: requestedTokens[0]!,
      });
      return {
        ...created.account,
        tokenType: created.tokenType,
        credentialMode: resolveStoredCredentialMode(created.account),
        capabilities: buildCapabilitiesForAccount(created.account),
        modelCount: created.modelCount,
        apiTokenFound: created.apiTokenFound,
        usernameDetected: created.usernameDetected,
        queued: created.queued,
        jobId: created.jobId,
        message: created.message,
      };
    } catch (err: any) {
      return reply.code(400).send({
        success: false,
        requiresVerification: err?.requiresVerification === true,
        message:
          credentialMode !== "apikey"
            ? appendSessionTokenRebindHint(err?.message || "Token 验证失败")
            : err?.message || "API Key 验证失败",
      });
    }
  });

  // Update an account
  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/accounts/:id",
    async (request, reply) => {
      const id = parseInt(request.params.id);
      const parsedBody = parseAccountUpdatePayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ message: parsedBody.error });
      }
      const body = parsedBody.data as Record<string, unknown>;
      const row = await db
        .select()
        .from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(eq(schema.accounts.id, id))
        .get();
      if (!row) {
        return reply.code(404).send({ message: "account not found" });
      }
      const account = row.accounts;
      const site = row.sites;
      const updates: any = {};
      for (const key of [
        "username",
        "accessToken",
        "apiToken",
        "status",
        "checkinEnabled",
        "unitCost",
        "extraConfig",
      ]) {
        if (body[key] !== undefined) updates[key] = body[key];
      }

      const wantsManagedSub2ApiAuthPatch =
        Object.prototype.hasOwnProperty.call(body, "refreshToken") ||
        Object.prototype.hasOwnProperty.call(body, "tokenExpiresAt");
      if (
        wantsManagedSub2ApiAuthPatch &&
        (site.platform || "").toLowerCase() === "sub2api"
      ) {
        const baseExtraConfig =
          typeof updates.extraConfig === "string"
            ? updates.extraConfig
            : account.extraConfig;
        const existingManagedAuth =
          getSub2ApiAuthFromExtraConfig(baseExtraConfig);

        const nextRefreshToken = Object.prototype.hasOwnProperty.call(
          body,
          "refreshToken",
        )
          ? normalizeManagedRefreshToken(body.refreshToken)
          : existingManagedAuth?.refreshToken;
        const nextTokenExpiresAt = Object.prototype.hasOwnProperty.call(
          body,
          "tokenExpiresAt",
        )
          ? normalizeManagedTokenExpiresAt(body.tokenExpiresAt)
          : existingManagedAuth?.tokenExpiresAt;

        updates.extraConfig = mergeAccountExtraConfig(baseExtraConfig, {
          sub2apiAuth: nextRefreshToken
            ? nextTokenExpiresAt
              ? {
                  refreshToken: nextRefreshToken,
                  tokenExpiresAt: nextTokenExpiresAt,
                }
              : { refreshToken: nextRefreshToken }
            : undefined,
        });
      }

      if (body.isPinned !== undefined) {
        const normalizedPinned = normalizePinnedFlag(body.isPinned);
        if (normalizedPinned === null) {
          return reply
            .code(400)
            .send({ message: "Invalid isPinned value. Expected boolean." });
        }
        updates.isPinned = normalizedPinned;
      }

      if (body.sortOrder !== undefined) {
        const normalizedSortOrder = normalizeSortOrder(body.sortOrder);
        if (normalizedSortOrder === null) {
          return reply
            .code(400)
            .send({
              message:
                "Invalid sortOrder value. Expected non-negative integer.",
            });
        }
        updates.sortOrder = normalizedSortOrder;
      }

      if (Object.prototype.hasOwnProperty.call(body, "proxyUrl")) {
        const baseExtraConfig =
          typeof updates.extraConfig === "string"
            ? updates.extraConfig
            : account.extraConfig;
        const {
          present,
          valid,
          proxyUrl: normalizedProxy,
        } = parseSiteProxyUrlInput(body.proxyUrl);
        if (present && !valid) {
          return reply.code(400).send({ message: "Invalid proxy URL format" });
        }
        updates.extraConfig = mergeAccountExtraConfig(baseExtraConfig, {
          proxyUrl: normalizedProxy ?? undefined,
        });
      }

      const nextAccessToken =
        typeof updates.accessToken === "string"
          ? updates.accessToken
          : account.accessToken;
      const nextApiToken = Object.prototype.hasOwnProperty.call(
        updates,
        "apiToken",
      )
        ? updates.apiToken
        : account.apiToken;
      const nextExtraConfig =
        typeof updates.extraConfig === "string"
          ? updates.extraConfig
          : account.extraConfig;
      const explicitNextMode =
        getCredentialModeFromExtraConfig(nextExtraConfig);
      const nextCredentialMode =
        explicitNextMode && explicitNextMode !== "auto"
          ? explicitNextMode
          : hasSessionTokenValue(nextAccessToken)
            ? "session"
            : "apikey";
      const nextStatus =
        typeof updates.status === "string" && updates.status.trim()
          ? updates.status.trim()
          : account.status || "active";
      const needsModelRefresh =
        Object.prototype.hasOwnProperty.call(body, "accessToken") ||
        Object.prototype.hasOwnProperty.call(body, "apiToken") ||
        Object.prototype.hasOwnProperty.call(body, "extraConfig") ||
        Object.prototype.hasOwnProperty.call(body, "proxyUrl") ||
        wantsManagedSub2ApiAuthPatch;
      const isExpiredApiKeyAccount =
        account.status === "expired" &&
        nextCredentialMode === "apikey" &&
        nextStatus !== "disabled";
      const shouldAttemptExpiredApiKeyRecovery =
        isExpiredApiKeyAccount && needsModelRefresh;

      const { account: updatedAccount } = await applyAccountUpdateWorkflow({
        accountId: id,
        updates,
        preferredApiToken:
          nextCredentialMode !== "apikey" ? nextApiToken : null,
        refreshModels: needsModelRefresh,
        preserveExpiredStatus: isExpiredApiKeyAccount,
        allowInactiveModelRefresh: shouldAttemptExpiredApiKeyRecovery,
        reactivateAfterSuccessfulModelRefresh:
          shouldAttemptExpiredApiKeyRecovery,
        continueOnError: true,
      });

      return updatedAccount;
    },
  );

  // Delete an account
  app.delete<{ Params: { id: string } }>(
    "/api/accounts/:id",
    async (request) => {
      const id = parseInt(request.params.id);
      await db.delete(schema.accounts).where(eq(schema.accounts.id, id)).run();
      await rebuildRoutesBestEffort();
      return { success: true };
    },
  );

  app.post<{ Body: unknown }>("/api/accounts/batch", async (request, reply) => {
    const parsedBody = parseAccountBatchPayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ message: parsedBody.error });
    }

    const ids = normalizeBatchIds(parsedBody.data.ids);
    const action = String(parsedBody.data.action || "").trim();
    if (ids.length === 0) {
      return reply.code(400).send({ message: "ids is required" });
    }
    if (!["enable", "disable", "delete", "refreshBalance"].includes(action)) {
      return reply.code(400).send({ message: "Invalid action" });
    }

    const successIds: number[] = [];
    const failedItems: Array<{ id: number; message: string }> = [];
    let shouldRebuildRoutes = false;

    for (const id of ids) {
      try {
        if (action === "refreshBalance") {
          const result = await refreshBalance(id);
          if (!result) {
            failedItems.push({
              id,
              message: "Account not found or balance refresh unsupported",
            });
            continue;
          }
          successIds.push(id);
          continue;
        }

        const existing = await db
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.id, id))
          .get();
        if (!existing) {
          failedItems.push({ id, message: "Account not found" });
          continue;
        }

        if (action === "delete") {
          await db
            .delete(schema.accounts)
            .where(eq(schema.accounts.id, id))
            .run();
          shouldRebuildRoutes = true;
        } else {
          const nextStatus = action === "enable" ? "active" : "disabled";
          await db
            .update(schema.accounts)
            .set({ status: nextStatus, updatedAt: new Date().toISOString() })
            .where(eq(schema.accounts.id, id))
            .run();
        }

        successIds.push(id);
      } catch (error: any) {
        failedItems.push({
          id,
          message: error?.message || "Batch operation failed",
        });
      }
    }

    if (shouldRebuildRoutes) {
      await rebuildRoutesBestEffort();
    }

    return {
      success: true,
      successIds,
      failedItems,
    };
  });

  app.post<{ Body: unknown }>(
    "/api/accounts/health/refresh",
    async (request, reply) => {
      const parsedBody = parseAccountHealthRefreshPayload(request.body);
      if (!parsedBody.success) {
        return reply
          .code(400)
          .send({ success: false, message: parsedBody.error });
      }

      const accountId = parsedBody.data.accountId;
      const wait = parsedBody.data.wait === true;

      if (wait) {
        const result = await executeRefreshAccountRuntimeHealth(accountId);
        if (accountId && result.summary.total === 0) {
          return reply
            .code(404)
            .send({ success: false, message: "账号不存在" });
        }
        return {
          success: true,
          ...result,
        };
      }

      const taskTitle = accountId
        ? `刷新账号运行健康状态 #${accountId}`
        : "刷新全部账号运行健康状态";
      const dedupeKey = accountId
        ? `refresh-account-runtime-health-${accountId}`
        : "refresh-all-account-runtime-health";

      const { task, reused } = startBackgroundTask(
        {
          type: "status",
          title: taskTitle,
          dedupeKey,
          notifyOnFailure: true,
          successMessage: (currentTask) => {
            const summary = (
              currentTask.result as {
                summary?: ReturnType<typeof summarizeAccountHealthRefresh>;
              }
            )?.summary;
            if (!summary) return `${taskTitle}已完成`;
            return `${taskTitle}完成：健康 ${summary.healthy}，异常 ${summary.unhealthy}，禁用 ${summary.disabled}`;
          },
          failureMessage: (currentTask) =>
            `${taskTitle}失败：${currentTask.error || "unknown error"}`,
        },
        async () => executeRefreshAccountRuntimeHealth(accountId),
      );

      return reply.code(202).send({
        success: true,
        queued: true,
        reused,
        jobId: task.id,
        status: task.status,
        message: reused
          ? "账号运行健康状态刷新进行中，请稍后查看账号列表"
          : "已开始刷新账号运行健康状态，请稍后查看账号列表",
      });
    },
  );

  // Refresh balance for an account
  app.post<{ Params: { id: string } }>(
    "/api/accounts/:id/balance",
    async (request, reply) => {
      const id = parseInt(request.params.id);
      try {
        const result = await refreshBalance(id);
        if (!result) {
          reply.code(404);
          return { message: "account not found or platform not supported" };
        }
        return result;
      } catch (err: any) {
        reply.code(400);
        return { message: err?.message || "failed to fetch balance" };
      }
    },
  );

  // Get model list for an account (available models + disabled status at site level)
  app.get<{ Params: { id: string } }>(
    "/api/accounts/:id/models",
    async (request, reply) => {
      const accountId = parseInt(request.params.id, 10);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return reply.code(400).send({ message: "账号 ID 无效" });
      }

      const account = await db
        .select()
        .from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(eq(schema.accounts.id, accountId))
        .get();

      if (!account) {
        return reply.code(404).send({ message: "账号不存在" });
      }

      const siteId = account.accounts.siteId;

      // Get available models for this account
      const modelRows = await db
        .select({
          modelName: schema.modelAvailability.modelName,
          available: schema.modelAvailability.available,
          latencyMs: schema.modelAvailability.latencyMs,
          isManual: schema.modelAvailability.isManual,
        })
        .from(schema.modelAvailability)
        .where(eq(schema.modelAvailability.accountId, accountId))
        .all();

      // Get disabled models for this site
      const disabledRows = await db
        .select({
          modelName: schema.siteDisabledModels.modelName,
        })
        .from(schema.siteDisabledModels)
        .where(eq(schema.siteDisabledModels.siteId, siteId))
        .all();

      const disabledSet = new Set(disabledRows.map((r) => r.modelName));

      const models = modelRows
        .filter((r) => r.available)
        .map((r) => ({
          name: r.modelName,
          latencyMs: r.latencyMs,
          disabled: disabledSet.has(r.modelName),
          isManual: !!r.isManual,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return {
        siteId,
        siteName: account.sites.name,
        models,
        totalCount: models.length,
        disabledCount: models.filter((m) => m.disabled).length,
      };
    },
  );

  for (const [method, mutate, failureMessage] of [
    ["POST", addManualModelsToAccount, "保存失败"],
    ["DELETE", removeManualModelsFromAccount, "删除失败"],
  ] as const) {
    app.route<{ Params: { id: string }; Body: unknown }>({
      method,
      url: "/api/accounts/:id/models/manual",
      handler: async (request, reply) => {
        const parsedBody = parseAccountManualModelsPayload(request.body);
        if (!parsedBody.success) {
          return reply.code(400).send({ message: parsedBody.error });
        }
        try {
          const result = await mutate(Number(request.params.id), parsedBody.data.models ?? []);
          return result ? { success: true, ...result } : { success: true };
        } catch (error) {
          const statusCode = error instanceof AccountManualModelServiceError ? error.statusCode : 500;
          return reply.code(statusCode).send({
            success: false,
            message: error instanceof Error ? error.message : failureMessage,
          });
        }
      },
    });
  }
}
