import React, { useEffect, useMemo, useState } from 'react';
import CenteredModal from './CenteredModal.js';
import { Button } from './ui/index.js';

type BoundedHistoryListProps<T> = {
  items: T[];
  getKey: (item: T) => React.Key;
  renderItem: (item: T, context: { inModal: boolean }) => React.ReactNode;
  emptyText: React.ReactNode;
  modalTitle: React.ReactNode;
  previewLimit?: number;
  pageSize?: number;
  listClassName?: string;
  listStyle?: React.CSSProperties;
  modalDescription?: React.ReactNode;
  modalMaxWidth?: number;
  viewAllLabel?: (count: number) => React.ReactNode;
};

export default function BoundedHistoryList<T>({
  items,
  getKey,
  renderItem,
  emptyText,
  modalTitle,
  previewLimit = 5,
  pageSize = 20,
  listClassName,
  listStyle,
  modalDescription,
  modalMaxWidth = 920,
  viewAllLabel = (count) => `查看全部（${count}）`,
}: BoundedHistoryListProps<T>) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const safePreviewLimit = Math.max(1, Math.trunc(previewLimit));
  const safePageSize = Math.max(1, Math.trunc(pageSize));
  const totalPages = Math.max(1, Math.ceil(items.length / safePageSize));
  const safePage = Math.min(page, totalPages);
  const previewItems = useMemo(
    () => items.slice(0, safePreviewLimit),
    [items, safePreviewLimit],
  );
  const modalItems = useMemo(
    () => items.slice((safePage - 1) * safePageSize, safePage * safePageSize),
    [items, safePage, safePageSize],
  );

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  if (items.length === 0) return <>{emptyText}</>;

  const renderList = (rows: T[], inModal: boolean) => (
    <div className={listClassName} style={listStyle}>
      {rows.map((item) => (
        <React.Fragment key={getKey(item)}>{renderItem(item, { inModal })}</React.Fragment>
      ))}
    </div>
  );

  return (
    <>
      {renderList(previewItems, false)}
      {items.length > safePreviewLimit ? (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
          <Button type="button" className="btn btn-ghost" onClick={() => { setPage(1); setOpen(true); }}>
            {viewAllLabel(items.length)}
          </Button>
        </div>
      ) : null}

      <CenteredModal
        open={open}
        onClose={() => setOpen(false)}
        title={modalTitle}
        maxWidth={modalMaxWidth}
        closeOnBackdrop
        closeOnEscape
        bodyStyle={{ overflow: 'hidden' }}
        footer={(
          <>
            <span style={{ marginRight: 'auto', color: 'var(--color-text-muted)', fontSize: 12 }}>
              共 {items.length} 条 · 第 {safePage}/{totalPages} 页
            </span>
            <Button type="button" variant="ghost" disabled={safePage <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
              上一页
            </Button>
            <Button type="button" variant="ghost" disabled={safePage >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>
              下一页
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>关闭</Button>
          </>
        )}
      >
        <div style={{ display: 'grid', gap: 12 }}>
          {modalDescription ? (
            <div style={{ color: 'var(--color-text-muted)', fontSize: 12, lineHeight: 1.6 }}>
              {modalDescription}
            </div>
          ) : null}
          <div style={{ maxHeight: 'min(62vh, 620px)', overflowY: 'auto', paddingRight: 4 }}>
            {renderList(modalItems, true)}
          </div>
        </div>
      </CenteredModal>
    </>
  );
}
