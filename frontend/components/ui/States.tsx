'use client';

import { Loader2, AlertTriangle, Inbox, RefreshCw } from 'lucide-react';

/** Componentes padrão pra loading/erro/empty estados em qualquer página. */
export function LoadingState({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted py-6 justify-center">
      <Loader2 size={14} className="animate-spin" /> {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 text-sm py-6 px-3 border border-danger/40 bg-danger/10 rounded">
      <div className="flex items-center gap-2 text-danger">
        <AlertTriangle size={14} /> {error}
      </div>
      {onRetry && (
        <button onClick={onRetry} className="text-xs text-accent hover:underline flex items-center gap-1">
          <RefreshCw size={12} /> Tentar novamente
        </button>
      )}
    </div>
  );
}

export function EmptyState({ label = 'Sem dados.' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 text-sm text-muted py-8">
      <Inbox size={20} className="opacity-50" /> {label}
    </div>
  );
}

/**
 * Utility: resolve qual componente renderizar.
 * Uso: <Resolved {...{loading,error,data,onRetry}}>{(d) => <table>...</table>}</Resolved>
 */
export function Resolved<T>({
  loading, error, data, onRetry, children, isEmpty,
}: {
  loading: boolean; error: string | null; data: T | null;
  onRetry?: () => void; isEmpty?: (d: T) => boolean;
  children: (d: T) => React.ReactNode;
}) {
  if (loading && data == null) return <LoadingState />;
  if (error && data == null) return <ErrorState error={error} onRetry={onRetry} />;
  if (data == null) return <EmptyState />;
  if (isEmpty?.(data)) return <EmptyState />;
  return <>{children(data)}</>;
}
