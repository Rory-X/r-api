export const BROWSER_RECOVERY_PROTOCOL = 'metapi.browser-recovery.v1';

export type BrowserRecoveryFieldKind = 'cookie' | 'local_storage' | 'session_storage' | 'header';
export type BrowserRecoveryCaptureStrategy =
  | 'cookie_header'
  | 'named_cookie'
  | 'storage_value'
  | 'json_path'
  | 'manual';

export type BrowserRecoveryCaptureSource = {
  strategy: BrowserRecoveryCaptureStrategy;
  key?: string;
  path?: string[];
};

export type BrowserRecoveryField = {
  name: string;
  kind: BrowserRecoveryFieldKind;
  required: boolean;
  capture?: BrowserRecoveryCaptureSource;
};

export type BrowserRecoveryTask = {
  id: string;
  mode: 'manual' | 'assisted' | 'managed';
  status: 'claimed';
  credentialName: string;
  adapterPlatform: string;
  targetUrl: string;
  targetOrigin: string;
  allowedOrigins: string[];
  fields: BrowserRecoveryField[];
  requiresUserGesture: boolean;
  expiresAt: string;
};

export type BrowserRecoveryLaunch = {
  serverUrl: string;
  taskId: string;
  taskToken: string;
};

const TASK_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function normalizeServerUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error('Metapi 服务地址无效');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Metapi 服务地址不能包含凭据、查询参数或片段');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
    throw new Error('远端 Metapi 服务必须使用 HTTPS');
  }
  return parsed.origin;
}

export function parseRecoveryLaunchUrl(value: string): BrowserRecoveryLaunch {
  let parsed: URL;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error('凭证采集链接无效');
  }
  if (!parsed.pathname.endsWith('/browser-credential-recovery')) {
    throw new Error('当前链接不是 Metapi 浏览器凭证任务');
  }
  const params = new URLSearchParams(parsed.hash.replace(/^#/, ''));
  const taskId = params.get('task') || '';
  const taskToken = params.get('token') || '';
  if (!taskId || taskId.length > 80 || !TASK_ID_PATTERN.test(taskId)) {
    throw new Error('浏览器凭证任务 id 无效');
  }
  if (taskToken.length < 32 || taskToken.length > 256 || !TOKEN_PATTERN.test(taskToken)) {
    throw new Error('浏览器凭证任务令牌无效');
  }
  return {
    serverUrl: normalizeServerUrl(parsed.origin),
    taskId,
    taskToken,
  };
}

export function originPermissionPattern(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('站点地址无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('浏览器凭证只支持 HTTP 或 HTTPS 站点');
  }
  return `${parsed.origin}/*`;
}

export function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  for (const allowed of allowedOrigins) {
    if (allowed === origin) return true;
    const wildcard = /^(https?):\/\/\*\.([^/:]+)(?::(\d+))?$/.exec(allowed);
    if (!wildcard) continue;
    try {
      const parsed = new URL(origin);
      const expectedPort = wildcard[3] || (wildcard[1] === 'https' ? '443' : '80');
      const actualPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      if (
        parsed.protocol === `${wildcard[1]}:`
        && actualPort === expectedPort
        && parsed.hostname.endsWith(`.${wildcard[2]}`)
        && parsed.hostname !== wildcard[2]
      ) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function resolveCaptureSource(field: BrowserRecoveryField): BrowserRecoveryCaptureSource {
  if (field.capture) return field.capture;
  if (field.kind === 'cookie') return { strategy: 'cookie_header' };
  if (field.kind === 'local_storage' || field.kind === 'session_storage') {
    return { strategy: 'storage_value', key: field.name };
  }
  return { strategy: 'manual' };
}

export function validateRecoveryTask(value: unknown, expectedTaskId?: string): BrowserRecoveryTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务响应无效');
  const task = value as Partial<BrowserRecoveryTask>;
  if (!task.id || task.id !== expectedTaskId || task.status !== 'claimed') throw new Error('任务状态无效');
  if (!['manual', 'assisted', 'managed'].includes(task.mode || '')) throw new Error('任务模式无效');
  if (!task.targetUrl || !task.targetOrigin || !task.expiresAt) throw new Error('任务缺少目标信息');
  const target = new URL(task.targetUrl);
  if (target.origin !== task.targetOrigin || !['http:', 'https:'].includes(target.protocol)) {
    throw new Error('任务目标站点无效');
  }
  const expiresAt = Date.parse(task.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('任务已过期');
  if (!Array.isArray(task.allowedOrigins) || !isOriginAllowed(task.targetOrigin, task.allowedOrigins)) {
    throw new Error('任务 Origin 白名单无效');
  }
  if (!Array.isArray(task.fields) || task.fields.length === 0) throw new Error('任务字段白名单为空');
  const seen = new Set<string>();
  for (const field of task.fields) {
    if (!field || typeof field.name !== 'string' || !field.name || field.name === '*' || seen.has(field.name)) {
      throw new Error('任务字段白名单无效');
    }
    seen.add(field.name);
    if (!['cookie', 'local_storage', 'session_storage', 'header'].includes(field.kind)) {
      throw new Error(`字段 ${field.name} 类型无效`);
    }
    const source = resolveCaptureSource(field);
    const key = source.key?.trim() || '';
    if (source.strategy === 'cookie_header' && field.kind !== 'cookie') throw new Error(`字段 ${field.name} 采集策略无效`);
    if (source.strategy === 'named_cookie' && (field.kind !== 'cookie' || !key)) throw new Error(`字段 ${field.name} 采集策略无效`);
    if (
      (source.strategy === 'storage_value' || source.strategy === 'json_path')
      && !['local_storage', 'session_storage'].includes(field.kind)
    ) throw new Error(`字段 ${field.name} 采集策略无效`);
    if ((source.strategy === 'storage_value' || source.strategy === 'json_path') && !key) {
      throw new Error(`字段 ${field.name} 采集 key 无效`);
    }
    if (source.strategy === 'json_path' && (!source.path?.length || source.path.some((part) => !part))) {
      throw new Error(`字段 ${field.name} JSON 路径无效`);
    }
  }
  return task as BrowserRecoveryTask;
}

export function buildCompletionFields(
  fields: BrowserRecoveryField[],
  values: Record<string, unknown>,
): Array<{ name: string; kind: BrowserRecoveryFieldKind; value: string }> {
  const output: Array<{ name: string; kind: BrowserRecoveryFieldKind; value: string }> = [];
  for (const field of fields) {
    const raw = values[field.name];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      if (field.required) throw new Error(`缺少必填浏览器字段: ${field.name}`);
      continue;
    }
    output.push({ name: field.name, kind: field.kind, value });
  }
  if (output.length === 0) throw new Error('至少需要采集一个浏览器字段');
  return output;
}
