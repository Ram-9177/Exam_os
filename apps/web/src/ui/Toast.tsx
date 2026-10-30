import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiEvents } from '@/lib/api';
import { cn } from './cn';
import { CheckIcon, CrossIcon, WarnIcon } from './icons';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';
export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** ms; 0 keeps it until dismissed. */
  duration?: number;
}
interface ToastItem extends Required<Omit<ToastInput, 'description'>> {
  id: number;
  description?: string;
}

interface ToastContextValue {
  toast: (t: ToastInput) => void;
  dismiss: (id: number) => void;
}
const ToastContext = createContext<ToastContextValue | null>(null);

/** Problem codes that screens handle themselves and should never become generic toasts. */
const HANDLED_CODES = new Set(['TOKEN_INVALID', 'SESSION_REVOKED']);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
  }, []);

  const toast = useCallback(
    (t: ToastInput) => {
      const id = ++counter.current;
      const item: ToastItem = { id, title: t.title, description: t.description, tone: t.tone ?? 'info', duration: t.duration ?? (t.tone === 'error' ? 9000 : 6000) };
      setItems((xs) => [...xs.slice(-4), item]);
      if (item.duration > 0) timers.current.set(id, setTimeout(() => dismiss(id), item.duration));
    },
    [dismiss],
  );

  // API problems surface here as "CODE — title" so staff can quote them to support.
  useEffect(
    () =>
      apiEvents.on('problem', (p) => {
        if (HANDLED_CODES.has(p.code)) return;
        toast({ tone: p.status >= 500 || p.status === 0 ? 'error' : 'warning', title: p.title, description: p.code + (p.requestId ? ` · request ${p.requestId}` : '') });
      }),
    [toast],
  );
  useEffect(() => apiEvents.on('signed-out', ({ reason }) => (reason === 'logout' ? undefined : toast({ tone: 'warning', title: 'Signed out', description: 'Your session ended. Sign in again to continue.' }))), [toast]);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[min(24rem,calc(100vw-2rem))]" aria-live="polite" aria-relevant="additions">
        {items.map((t) => (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className={cn('sheet-raised flex items-start gap-3 p-3 pr-2 text-sm', t.tone === 'error' && 'border-stop', t.tone === 'warning' && 'border-fix', t.tone === 'success' && 'border-ready')}>
            <span className={cn('mt-0.5 shrink-0', t.tone === 'error' && 'text-stop', t.tone === 'warning' && 'text-fix', t.tone === 'success' && 'text-ready', t.tone === 'info' && 'text-accent')}>
              {t.tone === 'success' ? <CheckIcon /> : t.tone === 'info' ? <CheckIcon /> : <WarnIcon />}
            </span>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-ink">{t.title}</p>
              {t.description ? <p className="text-ink-2 break-words">{t.description}</p> : null}
            </div>
            <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss notification" className="shrink-0 size-7 inline-flex items-center justify-center rounded-md text-ink-2 hover:bg-sheet-2">
              <CrossIcon size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
