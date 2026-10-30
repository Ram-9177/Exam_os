import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './cn';

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  count?: number | null;
}

export interface TabsProps<T extends string> {
  tabs: TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  children: ReactNode;
  className?: string;
}

/** WAI-ARIA tabs with roving tabindex and arrow-key movement. The panel is the children for the current value. */
export function Tabs<T extends string>({ tabs, value, onChange, label, children, className }: TabsProps<T>) {
  const base = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = tabs.findIndex((t) => t.id === value);
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    const target = tabs[next];
    if (!target) return;
    onChange(target.id);
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${base}-tab-${target.id}`)}`)?.focus();
  };

  return (
    <div className={className}>
      <div ref={listRef} role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex gap-1 border-b border-rule overflow-x-auto">
        {tabs.map((t) => {
          const selected = t.id === value;
          return (
            <button
              key={t.id}
              id={`${base}-tab-${t.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${base}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.id)}
              className={cn('relative -mb-px px-3 py-2.5 text-[15px] whitespace-nowrap border-b-2 transition-colors', selected ? 'border-ink text-ink font-medium' : 'border-transparent text-ink-2 hover:text-ink')}
            >
              {t.label}
              {typeof t.count === 'number' ? <span className="ml-1.5 tabular text-sm text-ink-2">{t.count}</span> : null}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`${base}-panel-${value}`} aria-labelledby={`${base}-tab-${value}`} tabIndex={0} className="pt-5 outline-none">
        {children}
      </div>
    </div>
  );
}
