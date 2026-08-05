import { forwardRef } from 'react';

interface DataTableProps<T> {
  columns: { key: string; label: string; align?: 'left' | 'right'; render?: (item: T) => React.ReactNode }[];
  data: T[];
  onRowClick?: (item: T) => void;
  selectedId?: string | null;
  idKey?: string;
  emptyMessage?: string;
}

function DataTableInner<T extends Record<string, unknown>>(
  { columns, data, onRowClick, selectedId, idKey = 'id', emptyMessage = 'No data to display' }: DataTableProps<T>,
  _ref: React.ForwardedRef<HTMLTableElement>
) {
  if (data.length === 0) {
    return (
      <div className="bg-surface border border-border rounded p-8 text-center">
        <p className="text-muted text-sm">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="bg-surface border border-border rounded overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" ref={_ref as React.Ref<HTMLTableElement>}>
          <thead>
            <tr className="border-b border-border bg-background">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`px-4 py-3 text-xs text-muted uppercase tracking-wider font-medium ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((item, i) => (
              <tr
                key={String(item[idKey] ?? i)}
                onClick={() => onRowClick?.(item)}
                className={`border-b border-border/50 transition-colors duration-150 ${
                  selectedId === String(item[idKey]) ? 'bg-primary/10' : 'hover:bg-surface-raised'
                } ${onRowClick ? 'cursor-pointer' : ''}`}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-4 py-3 ${col.align === 'right' ? 'text-right tabular-nums' : ''}`}
                  >
                    {col.render ? col.render(item) : String(item[col.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const DataTable = forwardRef(DataTableInner) as <T extends Record<string, unknown>>(
  props: DataTableProps<T> & { ref?: React.ForwardedRef<HTMLTableElement> }
) => ReturnType<typeof DataTableInner>;

export default DataTable;
