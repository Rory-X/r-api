import React, { useId, useState, type ReactNode } from "react";
import Button from "./Button.js";

type DisclosureProps = {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
};

export default function Disclosure({
  title,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
  className = "",
}: DisclosureProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const contentId = useId();
  const expanded = open ?? internalOpen;
  const setExpanded = (next: boolean) => {
    if (open === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div
      className={`ui-disclosure ${expanded ? "is-open" : ""} ${className}`.trim()}
    >
      <Button
        variant="link"
        className="ui-disclosure-trigger"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded(!expanded)}
      >
        <span>{title}</span>
        <span className="ui-disclosure-chevron" aria-hidden="true">
          <svg viewBox="0 0 16 16" focusable="false">
            <path d="m6 3.75 4.25 4.25L6 12.25" />
          </svg>
        </span>
      </Button>
      <div
        id={contentId}
        className="ui-disclosure-content"
        hidden={!expanded}
        aria-hidden={!expanded}
      >
        {children}
      </div>
    </div>
  );
}
