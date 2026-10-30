import type { ReactNode } from 'react';
import { cn } from './cn';

export interface Column<Row> {
  key: string;
  header: ReactNode;
  render: (row: Row) => ReactNode;
  align?: 'left' | 'right';
  width?: string;
  /** Hide below the md breakpoint to keep staff tables usable on a phone. */
  hideOnMobile?: boolean;
}

export interface TableProps<Row> {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  caption: string;
  /** Visually hide the caption (still read by screen readers). */
  hideCaption?: boolean;
  empty?: ReactNode;
  onRowClick?: (row: Row) => void;
  rowClassName?: (row: Row) => string | undefined;
  dense?: boolean;
  className?: string;
}

/** The register: ruled rows, no zebra, column headers in sentence case. */
export function Table<Row>({ columns, rows, rowKey, caption, hideCaption = true, empty, onRowClick, rowClassName, dense, className }: TableProps<Row>) {
  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full text-[15px]">
        <caption className={cn('text-left text-ink-2 text-sm pb-2', hideCaption && 'visually-hidden')}>{caption}</caption>
        <thead>
          <tr className="border-b border-rule-2">
            {columns.map((c) => (
              <th key={c.key} scope="col" style={{ width: c.width }} className={cn('py-2 pr-4 text-sm font-medium text-ink-2 whitespace-nowrap', c.align === 'right' ? 'text-right' : 'text-left', c.hideOnMobile && 'hidden md:table-cell')}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="py-8 text-center text-ink-2">
                {empty ?? 'Nothing here yet.'}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn('border-b border-rule align-top', onRowClick && 'cursor-pointer hover:bg-sheet-2', rowClassName?.(row))}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cn('pr-4', dense ? 'py-1.5' : 'py-2.5', c.align === 'right' ? 'text-right' : 'text-left', c.hideOnMobile && 'hidden md:table-cell')}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
