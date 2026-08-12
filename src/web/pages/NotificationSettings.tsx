import React, { useEffect, useState } from 'react';
import { api, type RuntimeSettingsPayload } from '../api.js';
import CenteredModal from '../components/CenteredModal.js';
import { useToast } from '../components/Toast.js';
import { tr } from '../i18n.js';
import { Button, Disclosure, Input, Option, Select, Switch } from '../components/ui/index.js';

type RuntimeSettings = {
    webhookUrl: string;
    barkUrl: string;
    webhookEnabled: boolean;
    barkEnabled: boolean;
    serverChanEnabled: boolean;
    telegramEnabled: boolean;
    telegramApiBaseUrl: string;
    telegramChatId: string;
    telegramUseSystemProxy: boolean;
    telegramMessageThreadId: string;
    smtpEnabled: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser: string;
    smtpPassMasked?: string;
    smtpFrom: string;
    smtpTo: string;
    serverChanKeyMasked?: string;
    telegramBotTokenMasked?: string;
    notifyCooldownSec: number;
    notifyDeliveryPolicy: 'prefer_delivery' | 'prefer_no_duplicate';
};

type NotificationOutboxRow = {
    id: number;
    channel: string;
    title: string;
    message: string;
    level: string;
    status: 'pending' | 'processing' | 'delivered' | 'delivery_unknown';
    attemptCount: number;
    nextAttemptAt?: string | null;
    lastError?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
};

type NotificationOutboxSnapshot = {
    policy: 'prefer_delivery' | 'prefer_no_duplicate';
    rows: NotificationOutboxRow[];
    summary: Record<string, number>;
    page?: {
        limit: number;
        offset: number;
        total: number;
        hasMore: boolean;
    };
};

const OUTBOX_PREVIEW_LIMIT = 5;
const OUTBOX_HISTORY_PAGE_SIZE = 20;

const OUTBOX_STATUS_LABELS: Record<NotificationOutboxRow['status'], string> = {
    pending: '等待投递',
    processing: '投递中',
    delivered: '已送达',
    delivery_unknown: '投递未知',
};

function formatOutboxDate(value?: string | null): string {
    if (!value) return '—';
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return value;
    return new Date(timestamp).toLocaleString();
}

export default function NotificationSettings() {
    const [runtime, setRuntime] = useState<RuntimeSettings>({
        webhookUrl: '',
        barkUrl: '',
        webhookEnabled: true,
        barkEnabled: true,
        serverChanEnabled: false,
        telegramEnabled: false,
        telegramApiBaseUrl: 'https://api.telegram.org',
        telegramChatId: '',
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
        notifyDeliveryPolicy: 'prefer_delivery',
    });

    const [serverChanKey, setServerChanKey] = useState('');
    const [telegramBotToken, setTelegramBotToken] = useState('');
    const [smtpPass, setSmtpPass] = useState('');
    const [loading, setLoading] = useState(true);
    const [savingNotify, setSavingNotify] = useState(false);
    const [testingNotify, setTestingNotify] = useState(false);
    const [outbox, setOutbox] = useState<NotificationOutboxSnapshot | null>(null);
    const [outboxLoading, setOutboxLoading] = useState(false);
    const [outboxHistoryOpen, setOutboxHistoryOpen] = useState(false);
    const [outboxHistory, setOutboxHistory] = useState<NotificationOutboxSnapshot | null>(null);
    const [outboxHistoryPage, setOutboxHistoryPage] = useState(1);
    const [outboxHistoryLoading, setOutboxHistoryLoading] = useState(false);
    const [retryingOutbox, setRetryingOutbox] = useState<number | 'all' | null>(null);
    const toast = useToast();

    const inputStyle: React.CSSProperties = {
        width: '100%',
        padding: '10px 14px',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 13,
        outline: 'none',
        background: 'var(--color-bg)',
        color: 'var(--color-text-primary)',
        transition: 'border-color 0.2s',
    };

    const loadSettings = async () => {
        setLoading(true);
        try {
            const runtimeInfo = await api.getRuntimeSettings();
            const webhookUrl = String(runtimeInfo.webhookUrl || '').trim();
            const barkUrl = String(runtimeInfo.barkUrl || '').trim();
            const serverChanKeyMasked = String(runtimeInfo.serverChanKeyMasked || '').trim();
            const telegramBotTokenMasked = String(runtimeInfo.telegramBotTokenMasked || '').trim();
            const telegramChatId = String(runtimeInfo.telegramChatId || '').trim();
            const smtpHost = String(runtimeInfo.smtpHost || '').trim();
            const smtpFrom = String(runtimeInfo.smtpFrom || '').trim();
            const smtpTo = String(runtimeInfo.smtpTo || '').trim();
            setRuntime({
                webhookUrl,
                barkUrl,
                webhookEnabled: runtimeInfo.webhookEnabled !== false && !!webhookUrl,
                barkEnabled: runtimeInfo.barkEnabled !== false && !!barkUrl,
                serverChanEnabled: !!runtimeInfo.serverChanEnabled && !!serverChanKeyMasked,
                telegramEnabled: !!runtimeInfo.telegramEnabled && !!telegramBotTokenMasked && !!telegramChatId,
                telegramApiBaseUrl: runtimeInfo.telegramApiBaseUrl || 'https://api.telegram.org',
                telegramChatId,
                telegramUseSystemProxy: !!runtimeInfo.telegramUseSystemProxy,
                telegramMessageThreadId: runtimeInfo.telegramMessageThreadId || '',
                smtpEnabled: !!runtimeInfo.smtpEnabled && !!smtpHost && !!smtpFrom && !!smtpTo,
                smtpHost,
                smtpPort: Number(runtimeInfo.smtpPort) || 587,
                smtpSecure: !!runtimeInfo.smtpSecure,
                smtpUser: runtimeInfo.smtpUser || '',
                smtpPassMasked: runtimeInfo.smtpPassMasked || '',
                smtpFrom,
                smtpTo,
                serverChanKeyMasked,
                telegramBotTokenMasked,
                notifyCooldownSec: Number.isFinite(Number(runtimeInfo.notifyCooldownSec))
                    ? Math.max(0, Math.trunc(Number(runtimeInfo.notifyCooldownSec)))
                    : 300,
                notifyDeliveryPolicy: runtimeInfo.notifyDeliveryPolicy === 'prefer_no_duplicate'
                    ? 'prefer_no_duplicate'
                    : 'prefer_delivery',
            });
        } catch (err: any) {
            toast.error(err?.message || '加载通知设置失败');
        } finally {
            setLoading(false);
        }
    };

    const loadOutbox = async () => {
        setOutboxLoading(true);
        try {
            setOutbox(await api.getNotificationOutbox({ limit: OUTBOX_PREVIEW_LIMIT, offset: 0 }));
        } catch (err: any) {
            toast.error(err?.message || '加载通知投递状态失败');
        } finally {
            setOutboxLoading(false);
        }
    };

    const loadOutboxHistory = async (page: number) => {
        const nextPage = Math.max(1, Math.trunc(page));
        setOutboxHistoryLoading(true);
        try {
            const snapshot = await api.getNotificationOutbox({
                limit: OUTBOX_HISTORY_PAGE_SIZE,
                offset: (nextPage - 1) * OUTBOX_HISTORY_PAGE_SIZE,
            });
            setOutboxHistory(snapshot);
            setOutboxHistoryPage(nextPage);
        } catch (err: any) {
            toast.error(err?.message || '加载完整通知投递记录失败');
        } finally {
            setOutboxHistoryLoading(false);
        }
    };

    const openOutboxHistory = () => {
        setOutboxHistoryOpen(true);
        void loadOutboxHistory(1);
    };

    useEffect(() => {
        void Promise.all([loadSettings(), loadOutbox()]);
    }, []);

    const saveNotify = async () => {
        setSavingNotify(true);
        try {
            const payload: RuntimeSettingsPayload = {
                webhookUrl: runtime.webhookUrl,
                barkUrl: runtime.barkUrl,
                webhookEnabled: runtime.webhookEnabled,
                barkEnabled: runtime.barkEnabled,
                serverChanEnabled: runtime.serverChanEnabled,
                telegramEnabled: runtime.telegramEnabled,
                telegramApiBaseUrl: runtime.telegramApiBaseUrl,
                telegramChatId: runtime.telegramChatId,
                telegramUseSystemProxy: runtime.telegramUseSystemProxy,
                telegramMessageThreadId: runtime.telegramMessageThreadId,
                smtpEnabled: runtime.smtpEnabled,
                smtpHost: runtime.smtpHost,
                smtpPort: runtime.smtpPort,
                smtpSecure: runtime.smtpSecure,
                smtpUser: runtime.smtpUser,
                smtpFrom: runtime.smtpFrom,
                smtpTo: runtime.smtpTo,
                notifyCooldownSec: Math.max(0, Math.trunc(Number(runtime.notifyCooldownSec) || 0)),
                notifyDeliveryPolicy: runtime.notifyDeliveryPolicy,
            };
            if (serverChanKey.trim()) payload.serverChanKey = serverChanKey.trim();
            if (telegramBotToken.trim()) payload.telegramBotToken = telegramBotToken.trim();
            if (smtpPass.trim()) payload.smtpPass = smtpPass.trim();

            const res = await api.updateRuntimeSettings(payload);
            setRuntime((prev) => ({
                ...prev,
                serverChanKeyMasked: res.serverChanKeyMasked || prev.serverChanKeyMasked,
                telegramBotTokenMasked: res.telegramBotTokenMasked || prev.telegramBotTokenMasked,
                smtpPassMasked: res.smtpPassMasked || prev.smtpPassMasked,
            }));
            setServerChanKey('');
            setTelegramBotToken('');
            setSmtpPass('');
            toast.success('通知设置已保存');
            await loadOutbox();
        } catch (err: any) {
            toast.error(err?.message || '保存失败');
        } finally {
            setSavingNotify(false);
        }
    };

    const retryOutbox = async (id?: number) => {
        setRetryingOutbox(id === undefined ? 'all' : id);
        try {
            await api.retryNotificationOutbox(id);
            toast.success(id === undefined ? '已重新排队未知投递' : '已重新排队该通知');
            await loadOutbox();
            if (outboxHistoryOpen) await loadOutboxHistory(outboxHistoryPage);
        } catch (err: any) {
            toast.error(err?.message || '重新排队失败');
        } finally {
            setRetryingOutbox(null);
        }
    };

    const testNotify = async () => {
        setTestingNotify(true);
        try {
            const res = await api.testNotification();
            toast.success(res?.message || '测试通知已发送');
        } catch (err: any) {
            toast.error(err?.message || '触发测试通知失败');
        } finally {
            setTestingNotify(false);
        }
    };

    if (loading) {
        return (
            <div className="animate-fade-in">
                <div className="skeleton" style={{ width: 220, height: 28, marginBottom: 20 }} />
                <div className="skeleton" style={{ width: '100%', height: 320, borderRadius: 'var(--radius-sm)' }} />
            </div>
        );
    }

    const renderOutboxRow = (row: NotificationOutboxRow) => (
        <div key={row.id} style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '10px 12px',
            border: '1px solid var(--color-border-light)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-bg)',
        }}>
            <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13 }}>{row.title}</strong>
                    <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{row.channel}</span>
                    <span style={{ fontSize: 11, color: row.status === 'delivery_unknown' ? 'var(--color-warning)' : 'var(--color-text-muted)' }}>
                        {OUTBOX_STATUS_LABELS[row.status]}
                    </span>
                </div>
                <div
                    title={row.lastError || row.message}
                    style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                    {row.lastError || row.message} · 尝试 {row.attemptCount} 次 · {formatOutboxDate(row.updatedAt || row.createdAt)}
                </div>
            </div>
            {row.status === 'delivery_unknown' && (
                <Button
                    onClick={() => void retryOutbox(row.id)}
                    disabled={retryingOutbox !== null}
                    className="btn btn-secondary"
                    style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                >
                    {retryingOutbox === row.id ? '排队中...' : '重试'}
                </Button>
            )}
        </div>
    );

    const outboxHistoryTotal = outboxHistory?.page?.total ?? outbox?.page?.total ?? outbox?.rows.length ?? 0;
    const outboxHistoryTotalPages = Math.max(1, Math.ceil(outboxHistoryTotal / OUTBOX_HISTORY_PAGE_SIZE));

    return (
        <div className="animate-fade-in" style={{ paddingBottom: 40 }}>
            {/* 头部标题与操作 */}
            <div className="page-header">
                <h2 className="page-title">{tr('通知设置')}</h2>
                <div className="page-actions">
                    <Button onClick={testNotify} disabled={testingNotify} className="btn btn-success">
                        {testingNotify ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 发送中...</> : '发送测试通知'}
                    </Button>
                    <Button onClick={saveNotify} disabled={savingNotify} className="btn btn-primary">
                        {savingNotify ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存通知设置'}
                    </Button>
                </div>
            </div>

            <div className="management-page-stack" style={{ gap: 20 }}>

                <div className="card animate-slide-up stagger-1" style={{ padding: 20 }}>
                    <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>告警去噪与冷静期</div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
                        相同告警在冷静期内不会重复推送；冷静期结束后会自动合并重复条数。
                    </div>
                    <div style={{ maxWidth: 260 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>
                            冷静期（秒）
                        </div>
                        <Input
                            type="number"
                            min={0}
                            value={runtime.notifyCooldownSec}
                            onChange={(e) => setRuntime((prev) => ({
                                ...prev,
                                notifyCooldownSec: Math.max(0, Math.trunc(Number(e.target.value) || 0)),
                            }))}
                            style={inputStyle}
                        />
                    </div>
                </div>

                <div className="card animate-slide-up stagger-2" style={{ padding: 20 }}>
                    <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>通知投递策略</div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
                        这是网关全局策略，适用于所有通知渠道。投递结果不确定时，可选择继续重试或立即停止，避免重复通知。
                    </div>
                    <div style={{ maxWidth: 420 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>
                            不确定投递结果时
                        </div>
                        <Select
                            aria-label="通知投递策略"
                            value={runtime.notifyDeliveryPolicy}
                            onChange={(e) => setRuntime((prev) => ({
                                ...prev,
                                notifyDeliveryPolicy: e.target.value === 'prefer_no_duplicate'
                                    ? 'prefer_no_duplicate'
                                    : 'prefer_delivery',
                            }))}
                            style={{ width: '100%' }}
                        >
                            <Option value="prefer_delivery">宁可重发：继续重试，尽量保证送达</Option>
                            <Option value="prefer_no_duplicate">宁可漏发：停止重试，避免重复通知</Option>
                        </Select>
                    </div>
                </div>

                <div className="card animate-slide-up stagger-3" style={{ padding: 20 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                        <div>
                            <div style={{ fontWeight: 600, fontSize: 15 }}>最近通知投递</div>
                            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                                Outbox 会在服务重启后继续处理；“投递未知”可以人工重新排队。
                            </div>
                        </div>
                        <Button
                            onClick={() => void retryOutbox()}
                            disabled={outboxLoading || retryingOutbox !== null || (outbox?.summary.delivery_unknown || 0) === 0}
                            className="btn btn-secondary"
                            style={{ whiteSpace: 'nowrap' }}
                        >
                            {retryingOutbox === 'all' ? '重新排队中...' : '重试未知投递'}
                        </Button>
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '14px 0' }}>
                        {(['pending', 'processing', 'delivered', 'delivery_unknown'] as const).map((status) => (
                            <span key={status} style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                padding: '5px 9px',
                                borderRadius: 999,
                                background: status === 'delivery_unknown' ? 'var(--color-warning-soft)' : 'var(--color-bg)',
                                border: '1px solid var(--color-border-light)',
                                color: status === 'delivery_unknown' ? 'var(--color-warning)' : 'var(--color-text-secondary)',
                                fontSize: 12,
                            }}>
                                {OUTBOX_STATUS_LABELS[status]} {outbox?.summary[status] || 0}
                            </span>
                        ))}
                    </div>

                    {outboxLoading && !outbox ? (
                        <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>加载投递状态...</div>
                    ) : outbox?.rows.length ? (
                        <div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {outbox.rows.map(renderOutboxRow)}
                            </div>
                            {(outbox.page?.total || outbox.rows.length) > outbox.rows.length && (
                                <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
                                    <Button type="button" className="btn btn-ghost" onClick={openOutboxHistory}>
                                        查看全部投递（{outbox.page?.total || outbox.rows.length}）
                                    </Button>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>暂无通知投递记录</div>
                    )}
                </div>

                <CenteredModal
                    open={outboxHistoryOpen}
                    onClose={() => setOutboxHistoryOpen(false)}
                    title="全部通知投递"
                    maxWidth={960}
                    closeOnBackdrop
                    closeOnEscape
                    bodyStyle={{ overflow: 'hidden' }}
                    footer={(
                        <>
                            <span style={{ marginRight: 'auto', color: 'var(--color-text-muted)', fontSize: 12 }}>
                                共 {outboxHistoryTotal} 条 · 第 {outboxHistoryPage}/{outboxHistoryTotalPages} 页
                            </span>
                            <Button
                                type="button"
                                variant="ghost"
                                disabled={outboxHistoryLoading || outboxHistoryPage <= 1}
                                onClick={() => void loadOutboxHistory(outboxHistoryPage - 1)}
                            >
                                上一页
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                disabled={outboxHistoryLoading || outboxHistoryPage >= outboxHistoryTotalPages}
                                onClick={() => void loadOutboxHistory(outboxHistoryPage + 1)}
                            >
                                下一页
                            </Button>
                            <Button type="button" variant="ghost" onClick={() => setOutboxHistoryOpen(false)}>关闭</Button>
                        </>
                    )}
                >
                    <div style={{ display: 'grid', gap: 12 }}>
                        <div style={{ color: 'var(--color-text-muted)', fontSize: 12, lineHeight: 1.6 }}>
                            按创建时间从新到旧展示，每页 {OUTBOX_HISTORY_PAGE_SIZE} 条；记录区域独立滚动，不会继续拉长设置页。
                        </div>
                        <div style={{ maxHeight: 'min(62vh, 620px)', overflowY: 'auto', paddingRight: 4 }}>
                            {outboxHistoryLoading && !outboxHistory ? (
                                <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>加载中...</div>
                            ) : outboxHistory?.rows.length ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                    {outboxHistory.rows.map(renderOutboxRow)}
                                </div>
                            ) : (
                                <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>暂无通知投递记录</div>
                            )}
                        </div>
                    </div>
                </CenteredModal>

                {/* 卡片：Webhook & Bark */}
                <div className="card animate-slide-up stagger-4" style={{ padding: 24, border: (runtime.webhookEnabled || runtime.barkEnabled) ? '1px solid var(--color-primary)' : '1px solid var(--color-border-light)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-primary-light)', color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                            </div>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: 15 }}>Webhook & Bark</div>
                                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>通过 HTTP URL 推送消息通知（自动识别企业微信、飞书格式）</div>
                            </div>
                        </div>

                        <div style={{ display: 'flex', gap: 16 }}>
                            <Switch label="启用 Webhook" checked={runtime.webhookEnabled} onChange={(webhookEnabled) => setRuntime((prev) => ({ ...prev, webhookEnabled }))} />
                            <Switch label="启用 Bark" checked={runtime.barkEnabled} onChange={(barkEnabled) => setRuntime((prev) => ({ ...prev, barkEnabled }))} />
                        </div>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <div style={{ opacity: runtime.webhookEnabled ? 1 : 0.6, transition: 'opacity 0.2s' }}>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>Webhook URL</div>
                            <Input
                                value={runtime.webhookUrl}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, webhookUrl: e.target.value }))}
                                placeholder="https://your-webhook-url (可选)"
                                style={inputStyle}
                                disabled={!runtime.webhookEnabled}
                            />
                        </div>
                        <div style={{ opacity: runtime.barkEnabled ? 1 : 0.6, transition: 'opacity 0.2s' }}>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>Bark URL</div>
                            <Input
                                value={runtime.barkUrl}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, barkUrl: e.target.value }))}
                                placeholder="https://api.day.app/your_key (可选)"
                                style={inputStyle}
                                disabled={!runtime.barkEnabled}
                            />
                        </div>
                    </div>
                </div>

                <Disclosure
                    className="notification-disclosure animate-slide-up stagger-5"
                    title={<span className="notification-disclosure-title">
                        更多渠道
                        <span style={{ marginLeft: 8, color: 'var(--color-text-muted)', fontSize: 12, fontWeight: 400 }}>
                            Server酱
                        </span>
                    </span>}
                >

                {/* 卡片：Server酱 */}
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--color-border-light)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-warning-soft)', color: 'var(--color-warning)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                            </div>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: 15 }}>Server酱 (SendKey)</div>
                                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>微信推送消息支持</div>
                            </div>
                        </div>

                        <Switch label="启用 Server酱" checked={runtime.serverChanEnabled} onChange={(serverChanEnabled) => setRuntime((prev) => ({ ...prev, serverChanEnabled }))} />
                    </div>

                    <div style={{ opacity: runtime.serverChanEnabled ? 1 : 0.6, transition: 'opacity 0.2s' }}>
                        <code style={{ display: 'block', padding: '10px 14px', background: 'var(--color-bg)', borderRadius: 'var(--radius-sm)', fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border-light)', marginBottom: 10 }}>
                            当前配置: {runtime.serverChanKeyMasked || '未设置'}
                        </code>
                        <Input
                            type="password"
                            value={serverChanKey}
                            onChange={(e) => setServerChanKey(e.target.value)}
                            placeholder="输入新的 Server酱 Key（留空则不改）"
                            style={inputStyle}
                            disabled={!runtime.serverChanEnabled}
                        />
                    </div>
                </div>
                </Disclosure>

                {/* 卡片：Telegram */} 
                <div className="card animate-slide-up stagger-6" style={{ padding: 24, border: runtime.telegramEnabled ? '1px solid var(--color-primary)' : '1px solid var(--color-border-light)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-primary-light)', color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 11l18-8-6 18-3-7-9-3z" /></svg>
                            </div>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: 15 }}>Telegram Bot</div>
                                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>通过 Telegram 机器人推送消息通知</div>
                            </div>
                        </div>

                        <Switch label="启用 Telegram" checked={runtime.telegramEnabled} onChange={(telegramEnabled) => setRuntime((prev) => ({ ...prev, telegramEnabled }))} />
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '16px 20px', opacity: runtime.telegramEnabled ? 1 : 0.6, transition: 'opacity 0.2s' }}>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>Telegram Chat ID</div>
                            <Input
                                value={runtime.telegramChatId}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, telegramChatId: e.target.value }))}
                                placeholder="例如: -1001234567890 或 @your_channel"
                                style={inputStyle}
                                disabled={!runtime.telegramEnabled}
                            />
                        </div>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>
                                Telegram Bot Token
                                {runtime.telegramBotTokenMasked && <span style={{ color: 'var(--color-primary)', marginLeft: 8, fontSize: 12 }}>(当前已设置)</span>}
                            </div>
                            <Input
                                type="password"
                                value={telegramBotToken}
                                onChange={(e) => setTelegramBotToken(e.target.value)}
                                placeholder="输入新的 Bot Token（留空则不改）"
                                style={inputStyle}
                                disabled={!runtime.telegramEnabled}
                            />
                        </div>
                    </div>

                    <Disclosure
                        className="notification-advanced-disclosure"
                        title={<span className="notification-advanced-disclosure-title">
                            高级设置
                            <span style={{ marginLeft: 8, color: 'var(--color-text-muted)', fontWeight: 400 }}>
                                代理、API 地址与 Topic
                            </span>
                        </span>}
                    >
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '16px 20px', marginTop: 16, opacity: runtime.telegramEnabled ? 1 : 0.6, transition: 'opacity 0.2s' }}>
                            <div style={{ gridColumn: '1 / -1' }}>
                                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>Telegram API Base URL</div>
                                <Input
                                    value={runtime.telegramApiBaseUrl}
                                    onChange={(e) => setRuntime((prev) => ({ ...prev, telegramApiBaseUrl: e.target.value }))}
                                    placeholder="例如: https://your-proxy.example.com"
                                    style={inputStyle}
                                    disabled={!runtime.telegramEnabled}
                                />
                                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>
                                    默认直连官方 Telegram API；网络受限时可填写反代前缀。
                                </div>
                            </div>
                            <div>
                                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>Telegram Topic ID</div>
                                <Input
                                    value={runtime.telegramMessageThreadId}
                                    onChange={(e) => setRuntime((prev) => ({ ...prev, telegramMessageThreadId: e.target.value }))}
                                    placeholder="例如: 77"
                                    style={inputStyle}
                                    disabled={!runtime.telegramEnabled}
                                />
                            </div>
                            <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 10 }}>
                                <Switch
                                    label="使用系统代理"
                                    checked={runtime.telegramUseSystemProxy}
                                    onChange={(telegramUseSystemProxy) => setRuntime((prev) => ({ ...prev, telegramUseSystemProxy }))}
                                    disabled={!runtime.telegramEnabled}
                                />
                            </div>
                        </div>
                    </Disclosure>
                </div>

                <Disclosure
                    className="notification-disclosure animate-slide-up stagger-7"
                    title={<span className="notification-disclosure-title">
                        邮件通知
                        <span style={{ marginLeft: 8, color: 'var(--color-text-muted)', fontSize: 12, fontWeight: 400 }}>
                            SMTP
                        </span>
                    </span>}
                >

                {/* 卡片：SMTP 邮件设置 */}
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--color-border-light)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-primary-light)', color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                            </div>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: 15 }}>邮件服务 (SMTP)</div>
                                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>通过电子邮件推送提醒</div>
                            </div>
                        </div>

                        <Switch label="启用 SMTP" checked={runtime.smtpEnabled} onChange={(smtpEnabled) => setRuntime((prev) => ({ ...prev, smtpEnabled }))} />
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '16px 20px', opacity: runtime.smtpEnabled ? 1 : 0.6, transition: 'opacity 0.2s' }}>
                        {/* Host */}
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>SMTP 服务器</div>
                            <Input
                                value={runtime.smtpHost}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, smtpHost: e.target.value }))}
                                placeholder="例如: smtp.qq.com"
                                style={inputStyle}
                                disabled={!runtime.smtpEnabled}
                            />
                        </div>
                        {/* Port & Secure */}
                        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end' }}>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>端口</div>
                                <Input
                                    type="number"
                                    min={1}
                                    value={runtime.smtpPort}
                                    onChange={(e) => setRuntime((prev) => ({ ...prev, smtpPort: Number(e.target.value) || 0 }))}
                                    style={inputStyle}
                                    disabled={!runtime.smtpEnabled}
                                />
                            </div>
                            <Switch
                                label="启用 TLS/SSL"
                                checked={runtime.smtpSecure}
                                onChange={(smtpSecure) => setRuntime((prev) => ({ ...prev, smtpSecure }))}
                                disabled={!runtime.smtpEnabled}
                                className="notification-inline-switch"
                            />
                        </div>
                        {/* User */}
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>账号用户</div>
                            <Input
                                value={runtime.smtpUser}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, smtpUser: e.target.value }))}
                                placeholder="SMTP 用户名"
                                style={inputStyle}
                                disabled={!runtime.smtpEnabled}
                            />
                        </div>
                        {/* Pass */}
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>
                                账号密码
                                {runtime.smtpPassMasked && <span style={{ color: 'var(--color-primary)', marginLeft: 8, fontSize: 12 }}>(当前已设置)</span>}
                            </div>
                            <Input
                                type="password"
                                value={smtpPass}
                                onChange={(e) => setSmtpPass(e.target.value)}
                                placeholder="输入以更改密码..."
                                style={inputStyle}
                                disabled={!runtime.smtpEnabled}
                            />
                        </div>
                        {/* From */}
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>发件人地址</div>
                            <Input
                                value={runtime.smtpFrom}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, smtpFrom: e.target.value }))}
                                placeholder="例如: admin@example.com"
                                style={inputStyle}
                                disabled={!runtime.smtpEnabled}
                            />
                        </div>
                        {/* To */}
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>接收地址</div>
                            <Input
                                value={runtime.smtpTo}
                                onChange={(e) => setRuntime((prev) => ({ ...prev, smtpTo: e.target.value }))}
                                placeholder="例如: target@example.com"
                                style={inputStyle}
                                disabled={!runtime.smtpEnabled}
                            />
                        </div>

                    </div>
                </div>
                </Disclosure>

            </div>
        </div>
    );
}
