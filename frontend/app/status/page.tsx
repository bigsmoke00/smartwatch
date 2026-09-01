'use client';

import { useEffect, useMemo, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

interface PubEndpoint {
  name: string; groupName: string | null; type: string;
  lastStatus: 'up' | 'down' | 'pending'; up24h: number; checks24h: number;
}

function uptime(e: PubEndpoint): number | null {
  return e.checks24h ? Math.round((e.up24h / e.checks24h) * 100) : null;
}

export default function PublicStatusPage() {
  const [data, setData] = useState<{ enabled: boolean; updatedAt?: string; endpoints?: PubEndpoint[] } | null>(null);
  const [token, setToken] = useState('');

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('token') || '';
    setToken(t);
    const fetchit = () => {
      fetch(`${API}/monitor/public/status?token=${encodeURIComponent(t)}`)
        .then((r) => r.json())
        .then(setData)
        .catch(() => setData({ enabled: false }));
    };
    fetchit();
    const id = setInterval(fetchit, 30000);
    return () => clearInterval(id);
  }, []);

  const eps = useMemo(() => data?.endpoints ?? [], [data]);
  const groups = useMemo(() => {
    const m = new Map<string, PubEndpoint[]>();
    for (const e of eps) { const g = e.groupName || 'Serviços'; if (!m.has(g)) m.set(g, []); m.get(g)!.push(e); }
    return Array.from(m.entries());
  }, [eps]);
  const anyDown = eps.some((e) => e.lastStatus === 'down');

  return (
    <div className="min-h-screen bg-bg text-text px-4 py-10 flex justify-center">
      <div className="w-full max-w-3xl">
        <div className="flex items-center gap-2.5 mb-6">
          <div className="w-8 h-8 rounded-lg bg-accent-gradient flex items-center justify-center font-extrabold text-white text-sm">S</div>
          <div className="font-semibold text-lg tracking-tight">SmartGard · Status</div>
        </div>

        {data && data.enabled === false ? (
          <div className="bg-panel border border-border rounded-xl p-8 text-center text-muted">
            Página de status indisponível.
            <div className="text-2xs text-mutedFaint mt-1">Requer um link válido (token). Configure <span className="font-mono">MONITOR_PUBLIC_TOKEN</span> no backend.</div>
          </div>
        ) : !data ? (
          <div className="text-muted text-sm py-8 text-center">Carregando…</div>
        ) : (
          <>
            <div className={`rounded-xl border px-5 py-4 mb-5 ${anyDown ? 'border-danger/40 bg-danger/10' : 'border-success/40 bg-success/10'}`}>
              <div className={`text-[15px] font-semibold ${anyDown ? 'text-danger' : 'text-success'}`}>
                {anyDown ? 'Instabilidade em alguns serviços' : 'Todos os sistemas operacionais'}
              </div>
              {data.updatedAt && <div className="text-2xs text-mutedFaint mt-0.5">Atualizado {new Date(data.updatedAt).toLocaleString()}</div>}
            </div>

            {groups.map(([g, list]) => (
              <div key={g} className="mb-5">
                <div className="text-[13px] font-semibold text-muted mb-2">{g}</div>
                <div className="bg-panel border border-border rounded-xl overflow-hidden divide-y divide-border/50">
                  {list.map((e, i) => {
                    const u = uptime(e);
                    const color = e.lastStatus === 'up' ? 'text-success' : e.lastStatus === 'down' ? 'text-danger' : 'text-mutedFaint';
                    return (
                      <div key={i} className="flex items-center justify-between px-4 py-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className={`w-2 h-2 rounded-full ${e.lastStatus === 'up' ? 'bg-success' : e.lastStatus === 'down' ? 'bg-danger' : 'bg-mutedFaint'}`} />
                          <span className="text-text truncate">{e.name}</span>
                          <span className="text-2xs text-mutedFaint uppercase">{e.type}</span>
                        </div>
                        <div className="flex items-center gap-4 shrink-0">
                          <span className="text-2xs text-mutedFaint font-mono">{u == null ? '—' : `${u}% 24h`}</span>
                          <span className={`text-2xs font-medium uppercase ${color}`}>{e.lastStatus === 'up' ? 'operacional' : e.lastStatus === 'down' ? 'fora' : 'pendente'}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {eps.length === 0 && <div className="text-muted text-sm py-8 text-center">Nenhum serviço publicado.</div>}
          </>
        )}

        <div className="text-2xs text-mutedFaint text-center mt-8">Powered by SmartGard</div>
      </div>
    </div>
  );
}
