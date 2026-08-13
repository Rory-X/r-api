import {
  buildCompletionFields,
  isOriginAllowed,
  parseRecoveryLaunchUrl,
  resolveCaptureSource,
  validateRecoveryTask,
  type BrowserRecoveryField,
  type BrowserRecoveryTask,
} from './protocol.js';

declare const chrome: any;

type RecoverySession = {
  serverUrl: string;
  taskId: string;
  claimToken: string;
  task: BrowserRecoveryTask;
  targetTabId?: number;
};

const SESSION_KEY = 'metapiBrowserRecoverySession';
const REQUEST_TIMEOUT_MS = 15_000;

function storageArea() {
  return chrome.storage.session || chrome.storage.local;
}

async function readSession(): Promise<RecoverySession | null> {
  const stored = await storageArea().get(SESSION_KEY);
  const session = stored?.[SESSION_KEY] as RecoverySession | undefined;
  if (!session) return null;
  if (!Number.isFinite(Date.parse(session.task?.expiresAt)) || Date.parse(session.task.expiresAt) <= Date.now()) {
    await storageArea().remove(SESSION_KEY);
    return null;
  }
  return session;
}

async function writeSession(session: RecoverySession): Promise<void> {
  await storageArea().set({ [SESSION_KEY]: session });
}

async function clearSession(): Promise<void> {
  await storageArea().remove(SESSION_KEY);
}

async function requestJson(url: string, init: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) {
      throw new Error(typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`);
    }
    return payload;
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw new Error('连接 r-api 服务超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function publicState(session: RecoverySession | null) {
  if (!session) return { active: false };
  return {
    active: true,
    serverUrl: session.serverUrl,
    task: session.task,
    targetTabId: session.targetTabId || null,
  };
}

async function claimTask(launchUrl: string) {
  const launch = parseRecoveryLaunchUrl(launchUrl);
  const response = await requestJson(`${launch.serverUrl}/api/browser-credential-tasks/public/claim`, {
    method: 'POST',
    body: JSON.stringify({
      taskId: launch.taskId,
      token: launch.taskToken,
      claimedBy: 'metapi-browser-extension/1',
    }),
  });
  if (typeof response.claimToken !== 'string' || response.claimToken.length < 32) {
    throw new Error('领取响应缺少 claim token');
  }
  const task = validateRecoveryTask(response.task, launch.taskId);
  const session: RecoverySession = {
    serverUrl: launch.serverUrl,
    taskId: launch.taskId,
    claimToken: response.claimToken,
    task,
  };
  await writeSession(session);
  return publicState(session);
}

async function openTarget() {
  const session = await readSession();
  if (!session) throw new Error('没有待处理的浏览器凭证任务');
  const tab = await chrome.tabs.create({ url: session.task.targetUrl, active: true });
  if (!Number.isInteger(tab?.id)) throw new Error('无法打开目标站点');
  session.targetTabId = tab.id;
  await writeSession(session);
  return publicState(session);
}

async function hasCapturePermissions(task: BrowserRecoveryTask): Promise<boolean> {
  const permissions = task.fields.some((field) => field.kind === 'cookie') ? ['cookies'] : [];
  return await chrome.permissions.contains({
    permissions,
    origins: [`${task.targetOrigin}/*`],
  });
}

async function readCookieValues(
  url: string,
  fields: BrowserRecoveryField[],
): Promise<Record<string, string>> {
  const cookieFields = fields.filter((field) => field.kind === 'cookie');
  if (cookieFields.length === 0) return {};
  const cookies = await chrome.cookies.getAll({ url });
  const usable = (Array.isArray(cookies) ? cookies : [])
    .filter((cookie) => !cookie.expirationDate || cookie.expirationDate > Date.now() / 1_000)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const result: Record<string, string> = {};
  for (const field of cookieFields) {
    const source = resolveCaptureSource(field);
    if (source.strategy === 'cookie_header') {
      result[field.name] = usable.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    } else if (source.strategy === 'named_cookie' && source.key) {
      result[field.name] = usable.find((cookie) => cookie.name === source.key)?.value || '';
    }
  }
  return result;
}

async function readPageValues(
  tabId: number,
  fields: BrowserRecoveryField[],
): Promise<{ origin: string; values: Record<string, string> }> {
  const pageFields = fields.filter((field) => field.kind !== 'cookie');
  const injection = await chrome.scripting.executeScript({
    target: { tabId },
    func: (declaredFields: BrowserRecoveryField[]) => {
      const values: Record<string, string> = {};
      for (const field of declaredFields) {
        const source = field.capture || (
          field.kind === 'local_storage' || field.kind === 'session_storage'
            ? { strategy: 'storage_value', key: field.name }
            : { strategy: 'manual' }
        );
        if (source.strategy === 'manual') continue;
        const storage = field.kind === 'local_storage'
          ? window.localStorage
          : field.kind === 'session_storage'
            ? window.sessionStorage
            : null;
        if (!storage || !source.key) continue;
        const raw = storage.getItem(source.key) || '';
        if (source.strategy === 'storage_value') {
          values[field.name] = raw;
          continue;
        }
        if (source.strategy !== 'json_path' || !raw || !source.path?.length) continue;
        try {
          let current: unknown = JSON.parse(raw);
          for (const part of source.path) {
            if (!current || typeof current !== 'object' || Array.isArray(current)) {
              current = undefined;
              break;
            }
            current = (current as Record<string, unknown>)[part];
          }
          if (typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean') {
            values[field.name] = String(current);
          }
        } catch {
          // Invalid page-owned JSON is treated as an unavailable optional field.
        }
      }
      return { origin: window.location.origin, values };
    },
    args: [pageFields],
  });
  const result = injection?.[0]?.result;
  if (!result || typeof result.origin !== 'string' || !result.values) {
    throw new Error('无法从目标标签页读取声明字段');
  }
  return result;
}

async function capture(tabId: number) {
  const session = await readSession();
  if (!session) throw new Error('没有待处理的浏览器凭证任务');
  if (!Number.isInteger(tabId)) throw new Error('目标标签页无效');
  if (!await hasCapturePermissions(session.task)) throw new Error('尚未授予目标 Origin 的临时采集权限');
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url) throw new Error('无法读取目标标签页地址');
  const currentOrigin = new URL(tab.url).origin;
  if (!isOriginAllowed(currentOrigin, session.task.allowedOrigins)) {
    throw new Error('当前标签页不在任务 Origin 白名单内');
  }
  const [page, cookies] = await Promise.all([
    readPageValues(tabId, session.task.fields),
    readCookieValues(tab.url, session.task.fields),
  ]);
  if (page.origin !== currentOrigin) throw new Error('目标标签页在采集期间发生跳转');
  session.targetTabId = tabId;
  await writeSession(session);
  return {
    ...publicState(session),
    origin: currentOrigin,
    values: { ...page.values, ...cookies },
  };
}

async function complete(input: { origin?: string; values?: Record<string, unknown>; username?: string }) {
  const session = await readSession();
  if (!session) throw new Error('没有待处理的浏览器凭证任务');
  const origin = typeof input.origin === 'string' ? new URL(input.origin).origin : '';
  if (!origin || !isOriginAllowed(origin, session.task.allowedOrigins)) throw new Error('提交 Origin 无效');
  const fields = buildCompletionFields(session.task.fields, input.values || {});
  const response = await requestJson(`${session.serverUrl}/api/browser-credential-tasks/public/complete`, {
    method: 'POST',
    body: JSON.stringify({
      taskId: session.taskId,
      claimToken: session.claimToken,
      origin,
      fields,
      username: typeof input.username === 'string' ? input.username.trim().slice(0, 256) || undefined : undefined,
    }),
  });
  await clearSession();
  return { completed: true, idempotent: response.idempotent === true };
}

async function handleMessage(message: any) {
  switch (message?.type) {
    case 'metapi.recovery.state':
      return publicState(await readSession());
    case 'metapi.recovery.claim':
      return claimTask(String(message.launchUrl || ''));
    case 'metapi.recovery.open-target':
      return openTarget();
    case 'metapi.recovery.capture':
      return capture(Number(message.tabId));
    case 'metapi.recovery.complete':
      return complete(message);
    case 'metapi.recovery.reset':
      await clearSession();
      return { active: false };
    default:
      throw new Error('未知扩展消息');
  }
}

chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (value: any) => void) => {
  void handleMessage(message).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});
