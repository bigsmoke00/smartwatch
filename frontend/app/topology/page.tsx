'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { apiFetch } from '@/lib/api';
import { fmtTime, safeArray } from '@/lib/utils';
import type { TopoNode, TopoEdge } from '@/components/TopologyGraph';
import { X, RefreshCw } from 'lucide-react';

// D3 só client-side
const TopologyGraph = dynamic(() => import('@/components/TopologyGraph'), { ssr: false });

export default function TopologyPage() {
  const [data, setData] = useState<{ nodes: TopoNode[]; edges: TopoEdge[] }>({ nodes: [], edges: [] });
  const [open, setOpen] = useState<TopoNode | null>(null);
  const [filter, setFilter] = useState<string>('all');

  async function load() {
    try {
      const r = await apiFetch<{ nodes: any[]; edges: any[] }>('/topology/graph');
      setData({
        nodes: safeArray<TopoNode>(r?.nodes),
        edges: safeArray<TopoEdge>(r?.edges),
      });
    } catch { setData({ nodes: [], edges: [] }); }
  }
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);

  const filteredNodes = filter === 'all'
    ? data.nodes
    : data.nodes.filter((n) => n.kind === filter);
  const visibleIds = new Set(filteredNodes.map((n) => n.id));
  const filteredEdges = data.edges.filter((e) => visibleIds.has(e.srcId) && visibleIds.has(e.dstId));

  // counts
  const counts = data.nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.kind] = (acc[n.kind] ?? 0) + 1;
    return acc;
  }, {});
  const downCount = data.nodes.filter((n) => n.status === 'down').length;

  return (
    <AppShell>
      <div className="p-6 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-2xl font-semibold">Topologia</h1>
          <div className="flex items-center gap-2">
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
            >
              <option value="all">Todos os tipos</option>
              <option value="server">Servidores</option>
              <option value="container">Containers</option>
              <option value="database">Bancos</option>
              <option value="lb">Load balancers</option>
              <option value="service">Serviços</option>
              <option value="external">Externos</option>
            </select>
            <Button variant="secondary" onClick={load}>
              <RefreshCw size={14} /> Atualizar
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          {Object.entries(counts).map(([k, n]) => (
            <Badge key={k}>{k}: {n}</Badge>
          ))}
          {downCount > 0 && (
            <Badge className="border-danger text-danger">● {downCount} down</Badge>
          )}
        </div>

        <div className="grid grid-cols-12 gap-3">
          <Card className="col-span-12 lg:col-span-9 p-0 overflow-hidden">
            <TopologyGraph
              nodes={filteredNodes}
              edges={filteredEdges}
              onNodeClick={(n) => setOpen(n)}
            />
          </Card>
          <Card className="col-span-12 lg:col-span-3 p-3 max-h-[78vh] overflow-auto">
            {open ? (
              <NodeDrawer node={open} onClose={() => setOpen(null)} />
            ) : (
              <div className="text-sm text-muted">
                Clique num nó para inspecionar.
                <ul className="text-xs mt-3 space-y-1">
                  <li><span className="inline-block w-2 h-2 rounded-full mr-1 bg-success"/> healthy</li>
                  <li><span className="inline-block w-2 h-2 rounded-full mr-1 bg-warn"/> degraded</li>
                  <li><span className="inline-block w-2 h-2 rounded-full mr-1 bg-danger"/> down</li>
                  <li><span className="inline-block w-2 h-2 rounded-full mr-1 bg-muted"/> unknown</li>
                </ul>
                <p className="text-xs mt-3">
                  Auto-discovery roda a cada 2min — ou clique em "Atualizar".
                </p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function NodeDrawer({ node, onClose }: { node: TopoNode; onClose: () => void }) {
  const [details, setDetails] = useState<any>(null);

  useEffect(() => {
    setDetails(null);
    const meta = (node as any).metadata ?? {};
    if (node.kind === 'server' && (node as any).refId) {
      apiFetch(`/servers/${(node as any).refId}`).then(setDetails).catch(() => setDetails(null));
    } else if (node.kind === 'database' && (node as any).refId) {
      apiFetch(`/pg/clusters/${(node as any).refId}/dashboard?minutes=15`).then(setDetails).catch(() => setDetails(null));
    } else if (node.kind === 'container' && meta.serverId) {
      // refId era "serverId:containerId"
      const cid = String((node as any).refId ?? '').split(':')[1];
      if (cid) {
        apiFetch(`/docker/${meta.serverId}/containers/${cid}/inspect`).then(setDetails).catch(() => setDetails(null));
      }
    }
  }, [node]);

  const link =
    node.kind === 'server' && (node as any).refId ? `/servers/${(node as any).refId}` :
    node.kind === 'database' && (node as any).refId ? `/databases` :
    node.kind === 'container' ? `/docker` :
    null;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium">{node.name}</h3>
        <button onClick={onClose} className="text-muted hover:text-text"><X size={14}/></button>
      </div>
      <div className="flex flex-wrap gap-1 mb-2">
        <Badge>{node.kind}</Badge>
        <Badge
          className={
            node.status === 'healthy' ? 'border-success text-success' :
            node.status === 'degraded' ? 'border-warn text-warn' :
            node.status === 'down' ? 'border-danger text-danger' : ''
          }
        >
          {node.status}
        </Badge>
      </div>

      {link && (
        <Link href={link} className="text-xs text-accent hover:underline block mb-3">
          Ver dashboard →
        </Link>
      )}

      {details && (
        <pre className="text-xs bg-bg p-2 rounded border border-border max-h-[40vh] overflow-auto whitespace-pre-wrap">
{JSON.stringify(details, null, 2)}
        </pre>
      )}
    </div>
  );
}
