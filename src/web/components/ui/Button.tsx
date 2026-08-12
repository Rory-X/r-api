import React, { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'soft-primary'
  | 'danger'
  | 'success'
  | 'ghost'
  | 'link';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
  loadingLabel?: ReactNode;
};

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  'soft-primary': 'btn-soft-primary',
  danger: 'btn-danger',
  success: 'btn-success',
  ghost: 'btn-ghost',
  link: 'btn-link',
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant,
  loading = false,
  loadingLabel,
  className = '',
  disabled,
  children,
  type = 'button',
  ...props
}, ref) {
  const normalizedClassName = className
    .split(/\s+/)
    .filter((name) => name && name !== 'btn')
    .join(' ');
  const hasVariantClass = /(?:^|\s)btn-(?:primary|secondary|soft-primary|danger|success|ghost|link)(?:\s|$)/.test(normalizedClassName);
  const variantClass = variant ? VARIANT_CLASSES[variant] : hasVariantClass ? '' : VARIANT_CLASSES.ghost;
  const content = loading ? (
    <>
      <span className="spinner spinner-sm" aria-hidden="true" />
      {loadingLabel ?? children}
    </>
  ) : children;

  return (
    <button
      ref={ref}
      type={type}
      className={`btn ${variantClass} ${normalizedClassName}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {content}
    </button>
  );
});

export default Button;
