'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from './api';

/**
 * Mesma forma que ServersService.ServerRow devolve (ver backend
 * servers/servers.service.ts, const COLS) — mantido como subset "seguro"
 * pra qualquer tela consumir sem precisar duplicar a interface.
 */
export interface ServerRow {
  id: string;
  name: string;
  description?: string | null;
  hostname?: string | null;
  ip?: string | null;
  cloud?: string | null;
  cloudRegion?: string | null;
  cloudAccount?: string | null;
  cloudInstanceId?: string | null;
  cloudAz?: string | null;
  os?: string | null;
  arch?: string | null;
  agentVersion?: string | null;
  tags?: string[];
  labels?: Record<string, any>;
  retentionDays?: number;
  logRateLimitPerMinute?: number | null;
  lastSeenAt?: string | null;
  createdAt?: string;
  // Campo legado usado por algumas telas antigas (ex: Scripts) — o backend
  // não devolve isso hoje (não existe coluna `environment` em `servers`),
  // então na prática é sempre undefined. Mantido só pra não quebrar a
  // tipagem de quem já lia esse campo.
  environment?: string;
}

// ---- cache em módulo (singleton, sem dependência nova tipo SWR) ------------
//
// Antes, CADA página (Logs, Docker, Scripts, Terminal, Exports, Unity,
// Dashboard...) fazia seu PRÓPRIO GET /servers ao montar — não existe layout
// persistente no app router aqui (cada page.tsx monta seu próprio <AppShell>,
// ver frontend/components/AppShell.tsx), então toda navegação refazia a
// chamada de rede do zero. Isso é uma das causas do "spinner" que o usuário
// reportou nos dropdowns de servidor espalhados pela aplicação.
//
// A lista é buscada UMA vez por carregamento de página (variável de módulo —
// sobrevive à troca de rota client-side do Next, porque o JS do bundle não
// recarrega) e compartilhada entre todos os componentes que chamam
// useServers() via um pub/sub simples (padrão "SWR manual").
let cache: ServerRow[] | null = null;
let inflight: Promise<ServerRow[]> | null = null;
const subscribers = new Set<() => void>();

function notify() {
  subscribers.forEach((fn) => fn());
}

function fetchServers(): Promise<ServerRow[]> {
  if (inflight) return inflight;
  inflight = apiFetch<ServerRow[]>('/servers')
    .then((rows) => {
      cache = Array.isArray(rows) ? rows : [];
      return cache;
    })
    .catch(() => {
      // Cacheia vazio em vez de deixar `cache` null pra sempre — evita
      // re-tentar em loop silencioso; quem precisar pode chamar reload().
      cache = [];
      return cache;
    })
    .finally(() => {
      inflight = null;
      notify();
    });
  return inflight;
}

/** Força um novo fetch e invalida o cache — usar depois de criar/editar/excluir um servidor. */
export function invalidateServersCache(): Promise<ServerRow[]> {
  cache = null;
  return fetchServers();
}

// ---- agrupamento em 2 níveis: cloud, e (dentro de qualquer cloud com mais
// de uma região distinta) sub-agrupado por região ----------------------------
export interface ServerGroup {
  cloud: string;
  /** null quando essa cloud não tem >1 região distinta (não é sub-agrupada). */
  region: string | null;
  /** Chave estável pra usar como value/key de <option> (cloud+região). */
  key: string;
  /** Rótulo pronto pra exibir, ex.: "AWS · us-east-1", "On-premise", "OCI". */
  label: string;
  servers: ServerRow[];
}

const CLOUD_LABELS: Record<string, string> = {
  aws: 'AWS',
  oci: 'OCI',
  gcp: 'GCP',
  azure: 'Azure',
  onprem: 'On-premise',
  other: 'Outro',
};

function cloudLabel(cloud: string): string {
  return CLOUD_LABELS[cloud] ?? cloud;
}

/**
 * Agrupa por `cloud` e, dentro de QUALQUER cloud com mais de uma região
 * distinta entre seus servidores, sub-agrupa por `cloudRegion` — não só AWS,
 * já que o usuário pode cadastrar mais servidores OCI/GCP em regiões
 * diferentes no futuro. Cloud/região ausentes caem em 'other'/'(sem região)'.
 */
export function groupServers(servers: ServerRow[]): ServerGroup[] {
  const byCloud = new Map<string, ServerRow[]>();
  for (const s of servers) {
    const c = s.cloud || 'other';
    if (!byCloud.has(c)) byCloud.set(c, []);
    byCloud.get(c)!.push(s);
  }

  const groups: ServerGroup[] = [];
  for (const [cloud, list] of byCloud) {
    const regions = new Set(list.map((s) => s.cloudRegion).filter(Boolean));
    if (regions.size > 1) {
      const byRegion = new Map<string, ServerRow[]>();
      for (const s of list) {
        const r = s.cloudRegion || '(sem região)';
        if (!byRegion.has(r)) byRegion.set(r, []);
        byRegion.get(r)!.push(s);
      }
      for (const [region, rlist] of byRegion) {
        groups.push({
          cloud,
          region,
          key: `${cloud}::${region}`,
          label: `${cloudLabel(cloud)} · ${region}`,
          servers: rlist,
        });
      }
    } else {
      groups.push({
        cloud,
        region: null,
        key: `${cloud}::`,
        label: cloudLabel(cloud),
        servers: list,
      });
    }
  }

  // Ordena por rótulo pra ficar estável na UI (senão a ordem muda conforme a
  // ordem de inserção no Map, que segue a ordem de created_at dos servidores).
  groups.sort((a, b) => a.label.localeCompare(b.label));
  return groups;
}

export interface UseServersResult {
  servers: ServerRow[];
  groups: ServerGroup[];
  loading: boolean;
  reload: () => Promise<ServerRow[]>;
}

/** Hook compartilhado — ver comentário do cache em módulo acima. */
export function useServers(): UseServersResult {
  const [servers, setServers] = useState<ServerRow[]>(cache ?? []);
  const [loading, setLoading] = useState(cache === null);

  useEffect(() => {
    const onChange = () => {
      setServers(cache ?? []);
      setLoading(false);
    };
    subscribers.add(onChange);
    if (cache === null) {
      setLoading(true);
      fetchServers();
    } else {
      onChange();
    }
    return () => {
      subscribers.delete(onChange);
    };
  }, []);

  const reload = useCallback(() => invalidateServersCache(), []);
  const groups = useMemo(() => groupServers(servers), [servers]);

  return { servers, groups, loading, reload };
}
