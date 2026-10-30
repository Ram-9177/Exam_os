import { Link, type LinkProps } from 'react-router';
import { cn } from './cn';
import type { ButtonSize, ButtonVariant } from './Button';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink border-accent hover:brightness-110',
  secondary: 'bg-sheet text-ink border-rule-2 hover:bg-sheet-2',
  ghost: 'bg-transparent text-ink border-transparent hover:bg-sheet-2',
  danger: 'bg-sheet text-stop border-stop hover:bg-stop-soft',
};
const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-[15px] gap-2',
  lg: 'h-12 px-6 text-base gap-2',
};

/** A router link that looks like a button (for navigation, never for actions). */
export function LinkButton({ variant = 'secondary', size = 'md', className, ...rest }: LinkProps & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link className={cn('inline-flex items-center justify-center rounded-md border font-medium whitespace-nowrap select-none transition-colors no-underline', variants[variant], sizes[size], className)} {...rest} />;
}
