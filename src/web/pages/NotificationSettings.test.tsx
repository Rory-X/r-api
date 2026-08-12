import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import { Disclosure, Select, Switch } from '../components/ui/index.js';
import NotificationSettings from './NotificationSettings.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getRuntimeSettings: vi.fn(),
    updateRuntimeSettings: vi.fn(),
    testNotification: vi.fn(),
    getNotificationOutbox: vi.fn(),
    retryNotificationOutbox: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('NotificationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getRuntimeSettings.mockResolvedValue({
      webhookUrl: '',
      barkUrl: '',
      webhookEnabled: true,
      barkEnabled: true,
      serverChanEnabled: false,
      telegramEnabled: true,
      telegramApiBaseUrl: 'https://tg-proxy.example.com',
      telegramChatId: '-1001234567890',
      telegramMessageThreadId: '77',
      telegramBotTokenMasked: '1234****token',
      telegramUseSystemProxy: false,
      smtpEnabled: false,
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: '',
      smtpFrom: '',
      smtpTo: '',
      notifyCooldownSec: 300,
    });
    apiMock.updateRuntimeSettings.mockResolvedValue({
      success: true,
      telegramApiBaseUrl: 'https://proxy.example.com/custom',
      telegramMessageThreadId: '88',
      telegramBotTokenMasked: '1234****token',
    });
    apiMock.testNotification.mockResolvedValue({ success: true });
    apiMock.getNotificationOutbox.mockResolvedValue({
      policy: 'prefer_delivery',
      rows: [],
      summary: {},
    });
    apiMock.retryNotificationOutbox.mockResolvedValue({ success: true, queued: 0 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads and saves telegram api base url and topic id', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <NotificationSettings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const proxyInput = root.root.find((node) => (
        node.type === 'input'
        && node.props.placeholder === '例如: https://your-proxy.example.com'
      ));
      expect(proxyInput.props.value).toBe('https://tg-proxy.example.com');

      const topicInput = root.root.find((node) => (
        node.type === 'input'
        && node.props.placeholder === '例如: 77'
      ));
      expect(topicInput.props.value).toBe('77');

      await act(async () => {
        proxyInput.props.onChange({ target: { value: 'https://proxy.example.com/custom/' } });
        topicInput.props.onChange({ target: { value: '88' } });
      });

      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('保存通知设置')
      ));
      await act(async () => {
        saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith(expect.objectContaining({
        telegramApiBaseUrl: 'https://proxy.example.com/custom/',
        telegramMessageThreadId: '88',
      }));
    } finally {
      root?.unmount();
    }
  });

  it('loads and saves telegram use system proxy toggle', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue({
      webhookUrl: '',
      barkUrl: '',
      webhookEnabled: true,
      barkEnabled: true,
      serverChanEnabled: false,
      telegramEnabled: true,
      telegramApiBaseUrl: 'https://api.telegram.org',
      telegramChatId: '-1001234567890',
      telegramBotTokenMasked: '1234****token',
      telegramUseSystemProxy: false,
      smtpEnabled: false,
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: '',
      smtpFrom: '',
      smtpTo: '',
      notifyCooldownSec: 300,
    });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <NotificationSettings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const proxySwitch = root.root.find((node) => (
        node.type === Switch && node.props.label === '使用系统代理'
      ));
      expect(proxySwitch.props.checked).toBe(false);

      await act(async () => {
        proxySwitch.props.onChange(true);
      });

      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('保存通知设置')
      ));
      await act(async () => {
        saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith(expect.objectContaining({
        telegramUseSystemProxy: true,
      }));
    } finally {
      root?.unmount();
    }
  });

  it('loads global delivery policy and requeues unknown outbox entries', async () => {
    apiMock.getRuntimeSettings.mockResolvedValue({
      webhookUrl: '',
      barkUrl: '',
      webhookEnabled: true,
      barkEnabled: true,
      serverChanEnabled: false,
      telegramEnabled: false,
      telegramApiBaseUrl: 'https://api.telegram.org',
      telegramChatId: '',
      telegramBotTokenMasked: '',
      telegramUseSystemProxy: false,
      telegramMessageThreadId: '',
      smtpEnabled: false,
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: '',
      smtpFrom: '',
      smtpTo: '',
      notifyCooldownSec: 300,
      notifyDeliveryPolicy: 'prefer_no_duplicate',
    });
    apiMock.getNotificationOutbox.mockResolvedValue({
      policy: 'prefer_no_duplicate',
      rows: [{
        id: 11,
        channel: 'feishu',
        title: '审批提醒',
        message: '需要人工确认',
        level: 'warning',
        status: 'delivery_unknown',
        attemptCount: 2,
        lastError: '网络超时',
        createdAt: '2026-08-03T08:00:00.000Z',
      }],
      summary: { delivery_unknown: 1 },
    });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <NotificationSettings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const policySelect = root.root.find((node) => (
        node.type === Select && node.props['aria-label'] === '通知投递策略'
      ));
      expect(policySelect.props.value).toBe('prefer_no_duplicate');
      expect(collectText(root.root)).toContain('投递未知');
      expect(collectText(root.root)).toContain('审批提醒');

      const retryButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node) === '重试'
      ));
      await act(async () => {
        retryButton.props.onClick();
      });
      await flushMicrotasks();
      expect(apiMock.retryNotificationOutbox).toHaveBeenCalledWith(11);
    } finally {
      root?.unmount();
    }
  });

  it('keeps the settings page to five recent deliveries and loads full history on demand', async () => {
    const row = (id: number) => ({
      id,
      channel: 'feishu',
      title: `通知 ${id}`,
      message: `投递内容 ${id}`,
      level: 'info',
      status: 'delivered' as const,
      attemptCount: 1,
      createdAt: `2026-08-12T08:${String(id).padStart(2, '0')}:00.000Z`,
    });
    apiMock.getNotificationOutbox
      .mockResolvedValueOnce({
        policy: 'prefer_delivery',
        rows: [row(12), row(11), row(10), row(9), row(8)],
        summary: { delivered: 12 },
        page: { limit: 5, offset: 0, total: 12, hasMore: true },
      })
      .mockResolvedValueOnce({
        policy: 'prefer_delivery',
        rows: Array.from({ length: 12 }, (_, index) => row(12 - index)),
        summary: { delivered: 12 },
        page: { limit: 20, offset: 0, total: 12, hasMore: false },
      });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <NotificationSettings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(apiMock.getNotificationOutbox).toHaveBeenNthCalledWith(1, { limit: 5, offset: 0 });
      expect(collectText(root.root)).not.toContain('通知 7');

      const viewAll = root.root.find((node) => (
        node.type === 'button' && collectText(node).includes('查看全部投递（12）')
      ));
      await act(async () => { viewAll.props.onClick(); });
      await flushMicrotasks();

      expect(apiMock.getNotificationOutbox).toHaveBeenNthCalledWith(2, { limit: 20, offset: 0 });
      expect(collectText(root.root)).toContain('通知 7');
      expect(collectText(root.root)).toContain('共 12 条');
    } finally {
      root?.unmount();
    }
  });

  it('does not present unconfigured channels as enabled and keeps low-frequency options collapsed', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <NotificationSettings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const webhookSwitch = root.root.find((node) => (
        node.type === Switch && node.props.label === '启用 Webhook'
      ));
      const barkSwitch = root.root.find((node) => (
        node.type === Switch && node.props.label === '启用 Bark'
      ));
      const serverChanSwitch = root.root.find((node) => (
        node.type === Switch && node.props.label === '启用 Server酱'
      ));

      expect(webhookSwitch.props.checked).toBe(false);
      expect(barkSwitch.props.checked).toBe(false);
      expect(serverChanSwitch.props.checked).toBe(false);

      const collapsedSections = root.root.findAll((node) => node.type === Disclosure);
      expect(collapsedSections).toHaveLength(3);
      expect(collapsedSections.every((section) => section.props.defaultOpen !== true && section.props.open !== true)).toBe(true);
      expect(collectText(root.root)).toContain('更多渠道');
      expect(collectText(root.root)).toContain('高级设置');
      expect(collectText(root.root)).toContain('邮件通知');
    } finally {
      root?.unmount();
    }
  });
});
