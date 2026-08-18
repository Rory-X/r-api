import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { formatDateTimeMinuteLocal } from '../pages/helpers/checkinLogTime.js';
import { buildEventNavigationPath } from '../pages/helpers/navigationFocus.js';
import { displayProgramEventTitle } from '../pages/helpers/programEventPresentation.js';
import { useI18n } from '../i18n.js';
import { useAnimatedVisibility } from './useAnimatedVisibility.js';
import { useIsMobile } from './useIsMobile.js';

const levelColors: Record<string, string> = {
  info: 'var(--color-info)',
  warning: 'var(--color-warning)',
  error: 'var(--color-danger)',
};

const typeLabels: Record<string, string> = {
  checkin: '签到',
  balance: '余额',
  token: '令牌',
  proxy: '代理',
  status: '状态',
  site_notice: '站点公告',
};

export default function NotificationPanel({
  open,
  onClose,
  anchorRef,
  onUnreadCountChange,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onUnreadCountChange?: (count: number) => void;
}) {
  const { t: tr } = useI18n();
  const isMobile = useIsMobile();
  const presence = useAnimatedVisibility(open, 160);
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<string>('');
  const panelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = filter ? `type=${filter}` : '';
      const data = await api.getEvents(params);
      setEvents(data);

      // Auto mark all as read on open
      const hasUnread = Array.isArray(data) && data.some((e: any) => !e.read);
      if (hasUnread) {
        api.markAllEventsRead().catch(() => {});
        onUnreadCountChange?.(0);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [filter, onUnreadCountChange]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        anchorRef.current && !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose, anchorRef]);

  const clearAll = async () => {
    await api.clearEvents();
    setEvents([]);
    onUnreadCountChange?.(0);
  };

  if (!presence.shouldRender) return null;

  const panel = (
    <div
      ref={panelRef}
      className={`user-dropdown notification-popover ${presence.isVisible ? '' : 'is-closing'}`.trim()}
      role="dialog"
      aria-label={tr('通知')}
    >
      {/* Header */}
      <div className="notification-popover-header">
        <span style={{ fontWeight: 600, fontSize: 14 }}>{tr('通知')}</span>
        <div className="notification-popover-header-actions">
          <button onClick={clearAll} className="btn btn-link">
            {tr('清空')}
          </button>
          {isMobile && (
            <button
              type="button"
              className="notification-popover-close"
              aria-label={tr('关闭')}
              title={tr('关闭')}
              onClick={onClose}
            >
              <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="notification-popover-filters">
        {['', 'checkin', 'balance', 'token', 'proxy', 'status', 'site_notice'].map((filterType) => (
          <button key={filterType} onClick={() => setFilter(filterType)}
            style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 12,
              border: filter === filterType ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
              background: filter === filterType ? 'var(--color-primary-light)' : 'transparent',
              color: filter === filterType ? 'var(--color-primary)' : 'var(--color-text-muted)',
              cursor: 'pointer',
            }}>
            {filterType ? tr(typeLabels[filterType] || filterType) : tr('全部')}
          </button>
        ))}
      </div>

      {/* Events list */}
      <div className="notification-popover-list">
        {loading && <div style={{ padding: 20, textAlign: 'center' }}><span className="spinner spinner-sm" /></div>}
        {!loading && events.length === 0 && (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>
            {tr('暂无通知')}
          </div>
        )}
        {events.map((ev: any) => {
          const targetPath = buildEventNavigationPath(ev);
          const eventTitle = displayProgramEventTitle(ev.title || '-');
          const eventMessage = String(ev.message || '');
          const openTarget = () => {
            onClose();
            navigate(targetPath);
          };
          return (
            <div
              key={ev.id}
              className="notification-event-item"
              style={{
                padding: '10px 16px',
                borderBottom: '1px solid var(--color-border-light)',
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
                cursor: 'pointer',
              }}
              onClick={openTarget}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openTarget();
                }
              }}
            >
              <div style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: 5,
                background: levelColors[ev.level] || 'var(--color-info)',
              }} />
              <div className="notification-event-content">
                <div className="notification-event-heading">
                  <span className="notification-event-title" title={eventTitle}>{eventTitle}</span>
                  <span className="notification-event-type">
                    {tr(typeLabels[ev.type] || ev.type)}
                  </span>
                </div>
                <div className="notification-event-message" title={eventMessage}>{eventMessage}</div>
                <div className="notification-event-time">
                  {formatDateTimeMinuteLocal(ev.createdAt)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return isMobile ? createPortal(panel, document.body) : panel;
}
