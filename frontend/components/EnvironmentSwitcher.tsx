'use client';

import { useEffect, useRef, useState } from 'react';
import { Layers, ChevronDown, Check } from 'lucide-react';
import { getActiveEnv } from '@/lib/api';
import { loadEnvironments, ensureActiveEnv, switchEnv, type Environment } from '@/lib/env';

/**
 * Seletor de ambiente (Prod/Lab) no topo. Ao trocar, recarrega a aplicação
 * inteira reescopando dados e menu ao ambiente escolhido — nada se mistura.
 */
export function EnvironmentSwitcher() {
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      const list = await loadEnvironments();
      setEnvs(list);
      const slug = await ensureActiveEnv();
      setActive(slug ?? getActiveEnv());
    })();
  }, []);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  if (!envs.length) return null;
  const current = envs.find((e) => e.slug === active) ?? envs[0];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Ambiente ativo"
        className="flex items-center gap-2 pl-2 pr-2 py-1.5 rounded-lg border border-border bg-bg hover:border-borderStrong transition-colors"
      >
        <Layers size={14} className="text-mutedFaint" />
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: current.color || '#1497a8' }}
        />
        <span className="text-xs text-text max-w-[120px] truncate">{current.name}</span>
        <ChevronDown size={13} className="text-mutedFaint" />
      </button>
      {open && (
        <div className="absolute right-0 mt-1.5 w-60 rounded-lg border border-border bg-panel shadow-elevate py-1 z-50 animate-fadeIn">
          <div className="px-3 py-1.5 text-2xs uppercase tracking-wide text-mutedFaint border-b border-border">
            Ambiente
          </div>
          {envs.map((e) => (
            <button
              key={e.id}
              onClick={() => {
                setOpen(false);
                switchEnv(e.slug);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-muted hover:text-text hover:bg-panel2 transition-colors"
            >
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: e.color || '#1497a8' }}
              />
              <span className="flex-1 text-left truncate">{e.name}</span>
              {e.slug === current.slug && <Check size={14} className="text-accentSoft" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
