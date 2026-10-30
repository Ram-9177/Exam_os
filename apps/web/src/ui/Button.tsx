import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';
import { Spinner } from './icons';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leading?: ReactNode;
}

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink border-accent hover:brightness-110 disabled:hover:brightness-100',
  secondary: 'bg-sheet text-ink border-rule-2 hover:bg-sheet-2',
  ghost: 'bg-transparent text-ink border-transparent hover:bg-sheet-2',
  danger: 'bg-sheet text-stop border-stop hover:bg-stop-soft',
};
const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-[15px] gap-2',
  lg: 'h-12 px-6 text-base gap-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', loading = false, leading, className, children, disabled, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn('inline-flex items-center justify-center rounded-md border font-medium whitespace-nowrap select-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed', variants[variant], sizes[size], className)}
      {...rest}
    >
      {loading ? <Spinner size={14} label="Working" /> : leading}
      {children}
    </button>
  );
});
