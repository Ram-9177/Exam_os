import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';
import { CrossIcon } from './icons';
import { Button } from './Button';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** `drawer` slides in from the right edge; `center` is a classic modal. */
  variant?: 'center' | 'drawer';
  /** When false, Escape and the backdrop do not close the dialog. */
  dismissable?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Visual tone of the title rule; used for destructive confirmations. */
  tone?: 'neutral' | 'danger';
}

const sizes = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };

/**
 * Accessible modal: role=dialog + aria-modal, focus moves inside on open, Tab
 * cycles within, Escape closes, focus returns to the opener on close, and the
 * rest of the app is made inert.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', variant = 'center', dismissable = true, initialFocusRef, tone = 'neutral' }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    const root = document.getElementById('root');
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (root) root.setAttribute('inert', '');

    const focusFirst = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = initialFocusRef?.current ?? (panel.querySelector<HTMLElement>('[data-autofocus]') || panel.querySelector<HTMLElement>(FOCUSABLE));
      (target ?? panel).focus();
    };
    const raf = requestAnimationFrame(focusFirst);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (dismissable) {
          e.preventDefault();
          onClose();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (root) root.removeAttribute('inert');
      const opener = openerRef.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [open, dismissable, onClose, initialFocusRef]);

  if (!open) return null;

  const isDrawer = variant === 'drawer';
  return createPortal(
    <div className={cn('fixed inset-0 z-50 flex', isDrawer ? 'justify-end' : 'items-center justify-center p-4')}>
      <div className="absolute inset-0 bg-[rgb(26_32_48/0.45)]" onClick={dismissable ? onClose : undefined} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn('relative sheet-raised flex flex-col w-full outline-none', isDrawer ? 'h-full max-w-xl rounded-none border-y-0 border-r-0' : cn('max-h-[90dvh]', sizes[size]))}
      >
        <header className={cn('flex items-start gap-4 px-6 pt-5 pb-4 border-b', tone === 'danger' ? 'border-stop' : 'border-rule')}>
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="text-h3">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="mt-1 text-sm text-ink-2">
                {description}
              </p>
            ) : null}
          </div>
          {dismissable ? (
            <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 -mr-2 -mt-1 size-9 inline-flex items-center justify-center rounded-md text-ink-2 hover:bg-sheet-2">
              <CrossIcon />
            </button>
          ) : null}
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer ? <footer className="flex flex-wrap items-center justify-end gap-2 px-6 py-4 border-t border-rule">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'neutral' | 'danger';
  busy?: boolean;
  disabled?: boolean;
}

/** A confirmation with one primary action; states plainly what will happen. */
export function ConfirmDialog({ open, onClose, onConfirm, title, children, confirmLabel, cancelLabel = 'Cancel', tone = 'neutral', busy = false, disabled = false }: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      tone={tone}
      dismissable={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={() => void onConfirm()} loading={busy} disabled={disabled} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
