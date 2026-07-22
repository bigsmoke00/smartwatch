'use client';
import { ReactNode } from 'react';

/**
 * Cabeçalho padrão de página: título + descrição opcional à esquerda,
 * ações (botões/filtros) à direita. Usar em toda página de primeiro nível
 * pra manter hierarquia visual consistente em toda a plataforma.
 */
export function PageHeader({
  title,
  description,
  icon,
  actions,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div className="flex items-start gap-3">
        {icon && (
          <div className="mt-0.5 w-9 h-9 rounded-lg bg-accent/10 border border-accent/25 flex items-center justify-center text-accentSoft shrink-0">
            {icon}
          </div>
        )}
        <div>
          <h1 className="text-[19px] font-bold tracking-tight text-text">{title}</h1>
          {description && <p className="text-[13px] text-muted mt-0.5">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
