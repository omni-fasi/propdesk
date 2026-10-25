import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { Spinner } from './Misc';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'buy' | 'sell';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-strong font-semibold',
  secondary: 'bg-panel-3 text-fg border border-line-strong hover:bg-[#222] hover:border-[#3a3a3a]',
  outline: 'border border-line-strong text-fg hover:bg-panel-2 hover:border-[#3a3a3a]',
  ghost: 'text-muted hover:text-fg hover:bg-panel-3',
  danger: 'border border-loss/50 text-loss hover:bg-loss/10 hover:border-loss',
  buy: 'bg-profit-strong text-white hover:bg-profit font-semibold',
  sell: 'bg-loss-strong text-white hover:bg-loss font-semibold',
};

const sizes: Record<ButtonSize, string> = {
  xs: 'h-6 px-2 text-xs gap-1 rounded',
  sm: 'h-7 px-2.5 text-[13px] gap-1.5 rounded-md',
  md: 'h-8 px-3 text-sm gap-2 rounded-md',
  lg: 'h-10 px-4 text-sm gap-2 rounded-lg',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, iconRight, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap transition-colors duration-100',
        'disabled:pointer-events-none disabled:opacity-40',
        variants[variant],
        sizes[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === 'lg' ? 16 : 14} /> : icon}
      {children}
      {iconRight}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible label, also used as the native tooltip. */
  label: string;
  icon: ReactNode;
  size?: ButtonSize;
  variant?: ButtonVariant;
  active?: boolean;
}

const iconSizes: Record<ButtonSize, string> = { xs: 'size-6', sm: 'size-7', md: 'size-8', lg: 'size-10' };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'sm', variant = 'ghost', active, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-100 disabled:pointer-events-none disabled:opacity-40',
        variants[variant],
        iconSizes[size],
        active && 'bg-panel-3 text-fg',
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
});
