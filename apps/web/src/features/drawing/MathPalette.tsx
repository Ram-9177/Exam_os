import { useMemo, useState } from 'react';
import { COMMON_FORMULAS, MATH_CATEGORIES, type MathCategory, type MathFormulaItem, type MathSymbolItem } from './mathSymbols';
import { Button, cn } from '@/ui';

export interface MathPaletteProps {
  onInsertToCanvas: (text: string) => void;
  onInsertToParagraph?: (text: string) => void;
  onClose?: () => void;
  className?: string;
}

export function MathPalette({ onInsertToCanvas, onInsertToParagraph, onClose, className }: MathPaletteProps) {
  const [activeTab, setActiveTab] = useState<string>('basic');
  const [search, setSearch] = useState<string>('');
  const [copiedNotification, setCopiedNotification] = useState<string | null>(null);

  const notify = (text: string) => {
    setCopiedNotification(text);
    setTimeout(() => {
      setCopiedNotification(null);
    }, 2000);
  };

  const filteredSymbols = useMemo(() => {
    if (!search.trim()) {
      if (activeTab === 'formulas') return [];
      const cat = MATH_CATEGORIES.find((c) => c.id === activeTab);
      return cat ? cat.items : [];
    }

    const q = search.toLowerCase().trim();
    const matches: MathSymbolItem[] = [];
    for (const cat of MATH_CATEGORIES) {
      for (const item of cat.items) {
        if (item.symbol.toLowerCase().includes(q) || item.name.toLowerCase().includes(q)) {
          matches.push(item);
        }
      }
    }
    return matches;
  }, [activeTab, search]);

  const filteredFormulas = useMemo(() => {
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      return COMMON_FORMULAS.filter(
        (f) =>
          f.title.toLowerCase().includes(q) ||
          f.category.toLowerCase().includes(q) ||
          f.formula.toLowerCase().includes(q) ||
          (f.description && f.description.toLowerCase().includes(q))
      );
    }
    return activeTab === 'formulas' ? COMMON_FORMULAS : [];
  }, [activeTab, search]);

  const handleSymbolClick = (symbol: string) => {
    try {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(symbol).catch(() => {});
      }
    } catch {
      /* ignore */
    }
    onInsertToCanvas(symbol);
    notify(`Inserted "${symbol}" onto canvas`);
  };

  const handleFormulaClick = (formula: string) => {
    try {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(formula).catch(() => {});
      }
    } catch {
      /* ignore */
    }
    onInsertToCanvas(formula);
    notify(`Inserted formula onto canvas`);
  };

  return (
    <div className={cn('sheet border border-rule-2 rounded-sm p-3 bg-sheet text-ink flex flex-col gap-2.5', className)}>
      <div className="flex items-center justify-between border-b border-rule pb-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm flex items-center gap-1.5 text-ink">
            <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent font-mono text-xs font-bold">∑ fx</span>
            Math Formulas & Symbols
          </span>
          {copiedNotification ? (
            <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded animate-fade-in" role="status">
              {copiedNotification}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="search"
            placeholder="Search symbol / formula (e.g. sqrt, integral, pi)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="text-xs rounded border border-rule-2 bg-sheet px-2 py-1 text-ink placeholder:text-ink-3 outline-none focus:border-accent w-48 sm:w-64"
            aria-label="Search mathematical symbols and formulas"
          />
          {onClose ? (
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close math palette">
              ✕
            </Button>
          ) : null}
        </div>
      </div>

      {!search.trim() ? (
        <div className="flex flex-wrap gap-1 border-b border-rule/50 pb-1.5" role="tablist" aria-label="Math symbol categories">
          {MATH_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              role="tab"
              aria-selected={activeTab === cat.id}
              onClick={() => setActiveTab(cat.id)}
              className={cn(
                'text-xs px-2 py-1 rounded transition-colors',
                activeTab === cat.id ? 'bg-sheet-2 text-ink font-semibold border border-rule-2' : 'text-ink-2 hover:text-ink hover:bg-sheet-2/60'
              )}
            >
              {cat.label}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'formulas'}
            onClick={() => setActiveTab('formulas')}
            className={cn(
              'text-xs px-2.5 py-1 rounded transition-colors font-medium',
              activeTab === 'formulas' ? 'bg-accent/15 text-accent font-semibold border border-accent/30' : 'text-accent hover:bg-accent/10'
            )}
          >
            ★ Standard Formulas
          </button>
        </div>
      ) : null}

      {/* Symbols Grid */}
      {filteredSymbols.length > 0 ? (
        <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 gap-1 max-h-48 overflow-y-auto p-0.5">
          {filteredSymbols.map((item) => (
            <button
              key={`${item.name}-${item.symbol}`}
              type="button"
              title={`${item.name} (${item.symbol}) — Click to insert on whiteboard`}
              onClick={() => handleSymbolClick(item.symbol)}
              className="flex flex-col items-center justify-center p-2 rounded border border-rule-2 hover:border-accent bg-sheet-2 hover:bg-sheet text-ink hover:text-accent transition-all active:scale-95 group"
            >
              <span className="font-serif text-lg leading-none select-none">{item.symbol}</span>
              <span className="text-[10px] text-ink-3 truncate w-full text-center mt-1 group-hover:text-ink-2 select-none">
                {item.name}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {/* Common Formulas List */}
      {filteredFormulas.length > 0 ? (
        <div className="flex flex-col gap-1.5 max-h-56 overflow-y-auto p-0.5">
          <p className="text-[11px] font-medium text-ink-3 uppercase tracking-wider">
            {search.trim() ? `Formulas matching "${search}"` : 'Standard Mathematical & Scientific Formulas'}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {filteredFormulas.map((f) => (
              <div
                key={f.title}
                className="p-2 rounded border border-rule-2 bg-sheet-2 flex flex-col justify-between gap-1 hover:border-accent transition-colors"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-ink">{f.title}</span>
                    <span className="text-[10px] text-ink-3 font-mono bg-sheet px-1.5 py-0.5 rounded border border-rule-2">
                      {f.category}
                    </span>
                  </div>
                  <div className="font-mono text-sm text-ink my-1 p-1 bg-sheet rounded border border-rule select-all">
                    {f.formula}
                  </div>
                  {f.description ? <p className="text-[11px] text-ink-2 leading-tight">{f.description}</p> : null}
                </div>
                <div className="flex items-center justify-end gap-1.5 mt-1 pt-1 border-t border-rule/50">
                  {onInsertToParagraph ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onInsertToParagraph(f.formula)}
                      title="Insert into active paragraph answer text"
                    >
                      Insert in Text
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => handleFormulaClick(f.formula)}
                    title="Place formula onto the whiteboard"
                  >
                    Place on Whiteboard
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {filteredSymbols.length === 0 && filteredFormulas.length === 0 ? (
        <div className="p-4 text-center text-sm text-ink-2">
          No math symbols or formulas found for &ldquo;{search}&rdquo;. Try another term like &ldquo;integral&rdquo;, &ldquo;root&rdquo;, or &ldquo;delta&rdquo;.
        </div>
      ) : null}
    </div>
  );
}
