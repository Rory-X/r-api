import nodemailer, { type Transporter } from 'nodemailer';
import { fetch } from 'undici';
import { config } from '../config.js';
import { formatLocalDateTime, getResolvedTimeZone } from './localTimeService.js';
import { withExplicitProxyRequestInit } from './siteProxy.js';

export const NOTIFICATION_CHANNELS = [
  'webhook',
  'bark',
  'serverchan',
  'telegram',
  'smtp',
] as const;

type StaticNotificationChannel = typeof NOTIFICATION_CHANNELS[number];
export type NotificationChannel = StaticNotificationChannel | 'feishu' | `feishu:${string}`;
export type NotificationLevel = 'info' | 'warning' | 'error';
export type NotificationDeliveryOutcome = 'delivered' | 'failed' | 'delivery_unknown';

export type NotificationChannelDispatchInput = {
  channel: NotificationChannel;
  title: string;
  message: string;
  level: NotificationLevel;
  occurredAt: string;
};

export type NotificationChannelDispatchResult = {
  channel: NotificationChannel;
  outcome: NotificationDeliveryOutcome;
  error: string | null;
  retryAfterMs: number | null;
};

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  if (typeof value !== 'string') return false;
  if ((NOTIFICATION_CHANNELS as readonly string[]).includes(value)) return true;
  return value === 'feishu' || /^feishu:[^:]+$/.test(value);
}

class ClassifiedNotificationDispatchError extends Error {
  constructor(
    readonly outcome: Exclude<NotificationDeliveryOutcome, 'delivered'>,
    message: string,
    readonly retryAfterMs: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ClassifiedNotificationDispatchError';
  }
}

let cachedSmtpFingerprint = '';
let cachedTransporter: Transporter | null = null;

function normalizeErrorMessage(error: unknown): string {
  const message = String((error as { message?: unknown })?.message || error || 'unknown error').trim();
  return message.slice(0, 2_000) || 'unknown error';
}

function knownFailure(message: string, retryAfterMs: number | null = null): never {
  throw new ClassifiedNotificationDispatchError('failed', message, retryAfterMs);
}

function unknownFailure(message: string, cause?: unknown): never {
  throw new ClassifiedNotificationDispatchError('delivery_unknown', message, null, { cause });
}

function requireHttpUrl(value: string, label: string): string {
  const normalized = value.trim();
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      knownFailure(`${label} must use http or https`);
    }
    return normalized;
  } catch (error) {
    if (error instanceof ClassifiedNotificationDispatchError) throw error;
    knownFailure(`${label} is invalid`);
  }
}

function parseRetryAfterMs(headers: { get(name: string): string | null } | undefined, nowMs = Date.now()): number | null {
  const raw = headers?.get('retry-after')?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(0, Math.trunc(seconds * 1_000));
  }
  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

function getSmtpFingerprint(): string {
  return [
    config.smtpHost,
    config.smtpPort,
    config.smtpSecure ? '1' : '0',
    config.smtpUser,
    config.smtpPass,
    config.smtpFrom,
    config.smtpTo,
  ].join('|');
}

function getSmtpTransporter(): Transporter {
  const fingerprint = getSmtpFingerprint();
  if (cachedTransporter && cachedSmtpFingerprint === fingerprint) {
    return cachedTransporter;
  }

  cachedTransporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser
      ? {
        user: config.smtpUser,
        pass: config.smtpPass,
      }
      : undefined,
  });
  cachedSmtpFingerprint = fingerprint;
  return cachedTransporter;
}

function resolveOccurredAt(value: string): Date {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function buildTimeFootnote(now: Date): string {
  const timeZone = getResolvedTimeZone();
  return [
    `Local Time: ${formatLocalDateTime(now)} (${timeZone})`,
    `UTC Time: ${now.toISOString()}`,
  ].join('\n');
}

function buildTelegramText(
  title: string,
  message: string,
  level: NotificationLevel,
  timeFootnote: string,
): string {
  const maxTextLength = 3_900;
  const raw = `[metapi][${level.toUpperCase()}] ${title}\n\n${message}\n\nLevel: ${level}\n${timeFootnote}`;
  if (raw.length <= maxTextLength) return raw;
  return `${raw.slice(0, maxTextLength)}\n\n...(truncated)`;
}

function isWeComBotWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'qyapi.weixin.qq.com' && parsed.pathname.includes('/cgi-bin/webhook/send');
  } catch {
    return false;
  }
}

function buildWeComText(
  title: string,
  message: string,
  level: NotificationLevel,
  timeFootnote: string,
): string {
  const maxLength = 1_900;
  const raw = `[metapi][${level.toUpperCase()}] ${title}\n\n${message}\n\n${timeFootnote}`;
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength)}\n...(truncated)`;
}

function isFeishuBotWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === 'open.feishu.cn' || parsed.hostname === 'open.larksuite.com')
      && parsed.pathname.includes('/open-apis/bot/v2/hook/')
    );
  } catch {
    return false;
  }
}

function buildFeishuText(
  title: string,
  message: string,
  level: NotificationLevel,
  timeFootnote: string,
): string {
  const maxLength = 3_900;
  const raw = `[metapi][${level.toUpperCase()}] ${title}\n\n${message}\n\n${timeFootnote}`;
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength)}\n...(truncated)`;
}

async function dispatchWebhook(input: NotificationChannelDispatchInput): Promise<void> {
  const webhookUrl = requireHttpUrl(config.webhookUrl, 'Webhook URL');
  const occurredAt = resolveOccurredAt(input.occurredAt);
  const timeFootnote = buildTimeFootnote(occurredAt);
  const isWeComWebhook = isWeComBotWebhook(webhookUrl);
  const isFeishuWebhook = isFeishuBotWebhook(webhookUrl);
  let body: string;

  if (isWeComWebhook) {
    body = JSON.stringify({
      msgtype: 'text',
      text: {
        content: buildWeComText(input.title, input.message, input.level, timeFootnote),
      },
    });
  } else if (isFeishuWebhook) {
    body = JSON.stringify({
      msg_type: 'text',
      content: {
        text: buildFeishuText(input.title, input.message, input.level, timeFootnote),
      },
    });
  } else {
    body = JSON.stringify({
      title: input.title,
      message: input.message,
      level: input.level,
      timestamp: occurredAt.toISOString(),
      localTime: formatLocalDateTime(occurredAt),
      timeZone: getResolvedTimeZone(),
    });
  }

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (error) {
    unknownFailure(`Webhook transport outcome is unknown: ${normalizeErrorMessage(error)}`, error);
  }

  if (!response.ok) {
    knownFailure(`Webhook response status ${response.status}`, parseRetryAfterMs(response.headers));
  }

  if (isWeComWebhook) {
    let payload: { errcode?: number; errmsg?: string };
    try {
      payload = await response.json() as { errcode?: number; errmsg?: string };
    } catch (error) {
      unknownFailure('Enterprise WeChat Webhook returned invalid JSON after accepting the request', error);
    }
    if (typeof payload.errcode === 'number' && payload.errcode !== 0) {
      knownFailure(`Enterprise WeChat Webhook error ${payload.errcode}: ${payload.errmsg || 'unknown error'}`);
    }
  }

  if (isFeishuWebhook) {
    let payload: { code?: number; msg?: string };
    try {
      payload = await response.json() as { code?: number; msg?: string };
    } catch (error) {
      unknownFailure('Feishu Webhook returned invalid JSON after accepting the request', error);
    }
    if (typeof payload.code === 'number' && payload.code !== 0) {
      knownFailure(`Feishu Webhook error ${payload.code}: ${payload.msg || 'unknown error'}`);
    }
  }
}

async function dispatchBark(input: NotificationChannelDispatchInput): Promise<void> {
  const barkBase = requireHttpUrl(config.barkUrl, 'Bark URL').replace(/\/+$/, '');
  const url = `${barkBase}/${encodeURIComponent(input.title)}/${encodeURIComponent(input.message)}`
    + `?group=AllApiHub&level=${encodeURIComponent(input.level)}`;
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, { method: 'GET' });
  } catch (error) {
    unknownFailure(`Bark transport outcome is unknown: ${normalizeErrorMessage(error)}`, error);
  }
  if (!response.ok) {
    knownFailure(`Bark response status ${response.status}`, parseRetryAfterMs(response.headers));
  }
}

async function dispatchServerChan(input: NotificationChannelDispatchInput): Promise<void> {
  const serverChanKey = config.serverChanKey.trim();
  if (!serverChanKey) knownFailure('ServerChan key is not configured');
  const occurredAt = resolveOccurredAt(input.occurredAt);
  const form = new URLSearchParams({
    title: input.title,
    desp: `${input.message}\n\nLevel: ${input.level}\n${buildTimeFootnote(occurredAt)}`,
  });
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(`https://sctapi.ftqq.com/${serverChanKey}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch (error) {
    unknownFailure(`ServerChan transport outcome is unknown: ${normalizeErrorMessage(error)}`, error);
  }
  if (!response.ok) {
    knownFailure(`ServerChan response status ${response.status}`, parseRetryAfterMs(response.headers));
  }
}

async function dispatchTelegram(input: NotificationChannelDispatchInput): Promise<void> {
  const botToken = config.telegramBotToken.trim();
  const chatId = config.telegramChatId.trim();
  if (!botToken || !chatId) knownFailure('Telegram bot token or chat ID is not configured');
  const telegramApiBaseUrl = requireHttpUrl(
    String(config.telegramApiBaseUrl || 'https://api.telegram.org'),
    'Telegram API Base URL',
  ).replace(/\/+$/, '');
  const telegramApiUrl = `${telegramApiBaseUrl}/bot${botToken}/sendMessage`;
  const occurredAt = resolveOccurredAt(input.occurredAt);
  const telegramMessageThreadId = Number.parseInt(String(config.telegramMessageThreadId || '').trim(), 10);
  const requestInit = withExplicitProxyRequestInit(
    config.telegramUseSystemProxy ? config.systemProxyUrl : null,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        ...(Number.isFinite(telegramMessageThreadId) && telegramMessageThreadId > 0
          ? { message_thread_id: telegramMessageThreadId }
          : {}),
        text: buildTelegramText(input.title, input.message, input.level, buildTimeFootnote(occurredAt)),
        disable_web_page_preview: true,
      }),
    },
  );

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(telegramApiUrl, requestInit);
  } catch (error) {
    unknownFailure(`Telegram transport outcome is unknown: ${normalizeErrorMessage(error)}`, error);
  }
  if (!response.ok) {
    knownFailure(`Telegram response status ${response.status}`, parseRetryAfterMs(response.headers));
  }

  let payload: { ok?: boolean; description?: string } | null = null;
  try {
    payload = await response.json() as { ok?: boolean; description?: string };
  } catch {}
  if (payload?.ok === false) {
    knownFailure(payload.description || 'Telegram returned a failure response');
  }
}

function isKnownSmtpFailure(error: unknown): boolean {
  const input = error as { code?: unknown; responseCode?: unknown };
  const responseCode = Number(input?.responseCode);
  if (Number.isFinite(responseCode) && responseCode >= 400) return true;
  const code = String(input?.code || '').trim().toUpperCase();
  return code === 'EAUTH' || code === 'EENVELOPE' || code === 'EMESSAGE';
}

async function dispatchSmtp(input: NotificationChannelDispatchInput): Promise<void> {
  if (!config.smtpHost.trim() || config.smtpPort <= 0 || !config.smtpFrom.trim() || !config.smtpTo.trim()) {
    knownFailure('SMTP host, sender, or recipient is not configured');
  }
  const occurredAt = resolveOccurredAt(input.occurredAt);
  try {
    await getSmtpTransporter().sendMail({
      from: config.smtpFrom,
      to: config.smtpTo,
      subject: `[metapi][${input.level.toUpperCase()}] ${input.title}`,
      text: `${input.message}\n\nLevel: ${input.level}\n${buildTimeFootnote(occurredAt)}`,
    });
  } catch (error) {
    const message = `SMTP delivery failed: ${normalizeErrorMessage(error)}`;
    if (isKnownSmtpFailure(error)) knownFailure(message);
    unknownFailure(`SMTP transport outcome is unknown: ${normalizeErrorMessage(error)}`, error);
  }
}

function feishuDeviceIdFromChannel(channel: NotificationChannel): string | null {
  if (!channel.startsWith('feishu:')) return null;
  const deviceId = channel.slice('feishu:'.length).trim();
  return deviceId || null;
}

async function dispatchFeishu(input: NotificationChannelDispatchInput): Promise<void> {
  // Dynamic import keeps the interaction adapter's existing local-connector
  // dependency out of the notification module initialization cycle.
  const { sendFeishuCardNotification } = await import('./feishuInteractionAdapterService.js');
  await sendFeishuCardNotification({
    deviceId: feishuDeviceIdFromChannel(input.channel),
    title: input.title,
    message: input.message,
    level: input.level,
    occurredAt: input.occurredAt,
  });
}

export function getConfiguredNotificationChannels(): NotificationChannel[] {
  const channels: NotificationChannel[] = [];
  if (config.webhookEnabled && config.webhookUrl.trim()) channels.push('webhook');
  if (config.barkEnabled && config.barkUrl.trim()) channels.push('bark');
  if (config.serverChanEnabled && config.serverChanKey.trim()) channels.push('serverchan');
  if (config.telegramEnabled && config.telegramBotToken.trim() && config.telegramChatId.trim()) channels.push('telegram');
  if (
    config.smtpEnabled
    && config.smtpHost.trim()
    && config.smtpPort > 0
    && config.smtpFrom.trim()
    && config.smtpTo.trim()
  ) {
    channels.push('smtp');
  }
  return channels;
}

export async function dispatchNotificationChannel(
  input: NotificationChannelDispatchInput,
): Promise<NotificationChannelDispatchResult> {
  try {
    switch (input.channel) {
      case 'webhook':
        await dispatchWebhook(input);
        break;
      case 'bark':
        await dispatchBark(input);
        break;
      case 'serverchan':
        await dispatchServerChan(input);
        break;
      case 'telegram':
        await dispatchTelegram(input);
        break;
      case 'smtp':
        await dispatchSmtp(input);
        break;
      case 'feishu':
      default:
        if (input.channel === 'feishu' || input.channel.startsWith('feishu:')) {
          await dispatchFeishu(input);
          break;
        }
        knownFailure(`Unsupported notification channel: ${input.channel}`);
    }
    return {
      channel: input.channel,
      outcome: 'delivered',
      error: null,
      retryAfterMs: null,
    };
  } catch (error) {
    if (error instanceof ClassifiedNotificationDispatchError) {
      return {
        channel: input.channel,
        outcome: error.outcome,
        error: normalizeErrorMessage(error),
        retryAfterMs: error.retryAfterMs,
      };
    }
    if ((error as { name?: unknown })?.name === 'KnownFeishuDeliveryError') {
      const retryAfterMs = Number((error as { retryAfterMs?: unknown })?.retryAfterMs);
      return {
        channel: input.channel,
        outcome: 'failed',
        error: normalizeErrorMessage(error),
        retryAfterMs: Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : null,
      };
    }
    return {
      channel: input.channel,
      outcome: 'delivery_unknown',
      error: normalizeErrorMessage(error),
      retryAfterMs: null,
    };
  }
}

export function __resetNotificationChannelDispatcherForTests(): void {
  cachedSmtpFingerprint = '';
  cachedTransporter = null;
}
