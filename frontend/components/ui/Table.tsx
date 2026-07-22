'use client';
import { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Tabela padrão (estilo do mockup): card arredondado, cabeçalho em maiúsculas
 * miúdas, linhas com hover e divisórias sutis. Mantém <table> nativa por
 * dentro pra não quebrar acessibilidade/semântica das telas existentes.
 *
 * Uso:
 *   <DataTable>
 *     <THeadRow><Th>Nome</Th><Th className="text-right">CPU</Th></THeadRow>
 *     <tbody>
 *       <Tr tone="danger"><Td>...</Td><Td className="text-right">89%</Td></Tr>
 *     </tbody>
 *   </DataTable>
 */
export function DataTable({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('bg-panel border border-border rounded-xl overflow-hidden', className)}>
      <table className="w-full text-left border-collapse">{children}</table>
    </div>
  );
}

export function THeadRow({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-border">{children}</tr>
    </thead>
  );
}

export function Th({ className, children, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'px-[18px] py-2.5 text-2xs font-medium uppercase tracking-wider text-mutedFaint whitespace-nowrap',
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export function Tr({
  className,
  tone,
  children,
  ...props
}: TdHTMLAttributes<HTMLTableRowElement> & { tone?: 'default' | 'danger' | 'warn' }) {
  return (
    <tr
      className={cn(
        'border-b border-border/50 last:border-0 transition-colors hover:bg-panel2/40',
        tone === 'danger' && 'bg-danger/[0.05]',
        tone === 'warn' && 'bg-warn/[0.05]',
        className,
      )}
      {...props}
    >
      {children}
    </tr>
  );
}

export function Td({ className, children, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('px-[18px] py-3 text-[12.5px] align-middle', className)} {...props}>
      {children}
    </td>
  );
}
