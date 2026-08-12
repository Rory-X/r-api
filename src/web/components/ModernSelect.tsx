import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type ModernSelectOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  iconNode?: ReactNode;
  iconUrl?: string;
  iconText?: string;
};

type ModernSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: ModernSelectOption[];
  'data-testid'?: string;
  placeholder?: string;
  disabled?: boolean;
  emptyLabel?: string;
  menuMaxHeight?: number;
  className?: string;
  size?: 'md' | 'sm';
  searchable?: boolean;
  searchPlaceholder?: string;
  optionDescriptionTooltipSide?: 'top' | 'right' | 'bottom' | 'left';
  'aria-label'?: string;
};

type MenuPosition = {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
  opensUpward: boolean;
};

const MENU_GAP = 8;
const MENU_VIEWPORT_MARGIN = 12;

export default function ModernSelect({
  value,
  onChange,
  options,
  'data-testid': dataTestId,
  placeholder = 'Select',
  disabled = false,
  emptyLabel = 'No options',
  menuMaxHeight = 280,
  className = '',
  size = 'md',
  searchable = false,
  searchPlaceholder = 'Search...',
  optionDescriptionTooltipSide,
  'aria-label': ariaLabel,
}: ModernSelectProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const canUsePortal = typeof document !== 'undefined'
    && !!document.body
    && typeof document.body.appendChild === 'function';

  const selected = useMemo(
    () => options.find((item) => item.value === value),
    [options, value],
  );

  const visibleOptions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!searchable || !query) return options;

    return options.filter((item) => {
      const haystack = [
        item.label,
        item.description,
        item.value,
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [options, searchQuery, searchable]);

  useEffect(() => {
    if (!open) return;
    if (typeof document === 'undefined') return;

    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !canUsePortal || !triggerRef.current || typeof window === 'undefined') return;

    const updateMenuPosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;

      const rect = trigger.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const availableBelow = viewportHeight - rect.bottom - MENU_GAP - MENU_VIEWPORT_MARGIN;
      const availableAbove = rect.top - MENU_GAP - MENU_VIEWPORT_MARGIN;
      const desiredHeight = Math.min(menuMaxHeight, 240);
      const opensUpward = availableBelow < desiredHeight && availableAbove > availableBelow;
      const availableHeight = opensUpward ? availableAbove : availableBelow;
      const width = Math.min(rect.width, Math.max(0, viewportWidth - MENU_VIEWPORT_MARGIN * 2));
      const left = Math.min(
        Math.max(MENU_VIEWPORT_MARGIN, rect.left),
        Math.max(MENU_VIEWPORT_MARGIN, viewportWidth - MENU_VIEWPORT_MARGIN - width),
      );

      setMenuPosition({
        left,
        top: opensUpward ? undefined : rect.bottom + MENU_GAP,
        bottom: opensUpward ? viewportHeight - rect.top + MENU_GAP : undefined,
        width,
        maxHeight: Math.max(0, Math.min(menuMaxHeight, availableHeight)),
        opensUpward,
      });
    };

    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [canUsePortal, menuMaxHeight, open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open && searchQuery) {
      setSearchQuery('');
    }
  }, [open, searchQuery]);

  const renderOptionIcon = (item: ModernSelectOption) => {
    if (item.iconNode) {
      return item.iconNode;
    }
    if (item.iconUrl) {
      return <img className="modern-select-option-icon" src={item.iconUrl} alt="" loading="lazy" />;
    }
    if (item.iconText) {
      return <span className="modern-select-option-icon-text">{item.iconText}</span>;
    }
    return null;
  };

  const panelStyle: CSSProperties = canUsePortal
    ? menuPosition
      ? {
        position: 'fixed',
        left: menuPosition.left,
        right: 'auto',
        top: menuPosition.top,
        bottom: menuPosition.bottom,
        width: menuPosition.width,
        maxHeight: menuPosition.maxHeight,
      }
      : {
        position: 'fixed',
        left: 0,
        right: 'auto',
        top: 0,
        width: 0,
        maxHeight: menuMaxHeight,
        visibility: 'hidden',
      }
    : { maxHeight: menuMaxHeight };

  const panel = (
    <div
      ref={panelRef}
      className={`modern-select-panel ${open ? 'is-open' : ''} ${canUsePortal ? 'is-portaled' : ''} ${menuPosition?.opensUpward ? 'opens-upward' : ''}`.trim()}
      style={panelStyle}
    >
      {searchable && (
        <div className="modern-select-search-shell">
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={searchPlaceholder}
            className="modern-select-search-input"
          />
        </div>
      )}

      {visibleOptions.length === 0 ? (
        <div className="modern-select-empty">{emptyLabel}</div>
      ) : (
        visibleOptions.map((item) => {
          const active = item.value === value;
          return (
            <button
              key={item.value}
              type="button"
              className={`modern-select-option ${active ? 'is-active' : ''} ${item.disabled ? 'is-disabled' : ''}`.trim()}
              data-tooltip={optionDescriptionTooltipSide ? item.description : undefined}
              data-tooltip-side={item.description ? optionDescriptionTooltipSide : undefined}
              aria-label={optionDescriptionTooltipSide && item.description
                ? `${item.label}: ${item.description}`
                : undefined}
              onClick={() => {
                if (item.disabled) return;
                onChange(item.value);
                setOpen(false);
              }}
              disabled={item.disabled}
            >
              <div className="modern-select-option-main">
                {renderOptionIcon(item)}
                <div style={{ minWidth: 0 }}>
                  <div className="modern-select-option-label">{item.label}</div>
                  {item.description && !optionDescriptionTooltipSide && (
                    <div className="modern-select-option-desc">{item.description}</div>
                  )}
                </div>
              </div>
              {active && (
                <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          );
        })
      )}
    </div>
  );

  return (
    <>
      <div
        ref={rootRef}
        data-testid={dataTestId}
        className={`modern-select ${open ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''} ${size === 'sm' ? 'is-sm' : ''} ${className}`.trim()}
      >
        <button
          ref={triggerRef}
          type="button"
          className="modern-select-trigger"
          onClick={() => {
            if (!disabled) setOpen((prev) => !prev);
          }}
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
        >
          <span className={`modern-select-value ${selected ? '' : 'is-placeholder'}`.trim()}>
            {selected ? (
              <span className="modern-select-value-content">
                {renderOptionIcon(selected)}
                <span>{selected.label}</span>
              </span>
            ) : (
              placeholder
            )}
          </span>
          <svg
            className="modern-select-chevron"
            width="14"
            height="14"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {!canUsePortal ? panel : null}
      </div>
      {canUsePortal && open ? createPortal(panel, document.body) : null}
    </>
  );
}
