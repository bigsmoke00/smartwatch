'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { apiFetch, ApiError } from '@/lib/api';
import { loadMyPermissions, hasPerm } from '@/lib/perms';
import { fmtTime, safeArray } from '@/lib/utils';
import { TerminalSquare } from 'lucide-react';

interface Cluster { id: string; name: string; database: string }
interface QueryResult { rows: any[]; rowCount: number; truncated: boolean; tookMs: number }
interface ReqRow {
  id: string; cluster_id: string; cluster_name: string; database: string | null;
  kind: 'read' | 'write'; sql_text: string; reason: string; context_query: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  requested_by_email?: string; approved_by_email?: string; executed_by_email?: string;
  row_count: number | null; error_text: string | null; created_at: string;
}

const STATUS_TONE: Record<string, 'default' | 'accent' | 'success' | 'warn' | 'danger' | 'info'> = {
  pending: 'warn',
  approved: 'accent',
  executed: 'success',
  rejected: 'danger',
  failed: 'danger',
};

export default function DbAccessPage() {
  const [perms, setPerms] = useState<Set<string> | null>(null);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [clusterId, setClusterId] = useState('');
  const [database, setDatabase] = useState('');
  const [databases, setDatabases] = useState<string[]>([]);
  const [loadingDatabases, setLoadingDatabases] = useState(false);

  // ---- leitura ad-hoc ----
  const [sql, setSql] = useState('SELECT now()');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  // ---- pedido de escrita ----
  const [writeSql, setWriteSql] = useState('');
  const [writeReason, setWriteReason] = useState('');
  const [showWriteForm, setShowWriteForm] = useState(false);

  // ---- fila ----
  const [requests, setRequests] = useState<ReqRow[]>([]);
  const [onlyPending, setOnlyPending] = useState(false);

  useEffect(() => { loadMyPermissions().then(setPerms); }, []);

  async function loadClusters() {
    setClusters(safeArray<Cluster>(await apiFetch('/db-access/clusters').catch(() => [])));
  }
  async function loadDatabases(id: string) {
    if (!id) { setDatabases([]); setDatabase(''); return; }
    setLoadingDatabases(true);
    try {
      const dbs = safeArray<string>(await apiFetch(`/db-access/clusters/${id}/databases`).catch(() => []));
      setDatabases(dbs);
      // se a database escolhida antes não existe nesse cluster, volta pro padrão
      setDatabase((prev) => (dbs.includes(prev) ? prev : ''));
    } finally {
      setLoadingDatabases(false);
    }
  }
  async function loadRequests() {
    const qs = onlyPending ? '?pending=true' : '';
    setRequests(safeArray<ReqRow>(await apiFetch(`/db-access/requests${qs}`).catch(() => [])));
  }
  useEffect(() => { loadClusters(); loadRequests(); const t = setInterval(loadRequests, 8_000); return () => clearInterval(t); }, [onlyPending]);
  useEffect(() => { loadDatabases(clusterId); }, [clusterId]);

  const canQuery = hasPerm(perms, 'db:query');
  const canWriteRequest = hasPerm(perms, 'db:write_request');
  const canApprove = hasPerm(perms, 'db:write_approve');

  async function runQuery() {
    if (!clusterId || !sql.trim()) return alert('selecione um cluster e informe o SQL');
    setRunning(true); setQueryError(null); setResult(null);
    try {
      const r = await apiFetch<QueryResult>('/db-access/query', {
        method: 'POST',
        body: JSON.stringify({ clusterId, database: database.trim() || undefined, sql }),
      });
      setResult(r);
    } catch (e) {
      setQueryError(e instanceof ApiError ? e.message : 'erro ao executar');
    } finally {
      setRunning(false);
    }
  }

  async function submitWriteRequest() {
    if (!clusterId || !writeSql.trim() || !writeReason.trim()) {
      return alert('selecione um cluster, informe o SQL de escrita e o motivo');
    }
    try {
      await apiFetch('/db-access/requests', {
        method: 'POST',
        body: JSON.stringify({
          clusterId, database: database.trim() || undefined, sql: writeSql, reason: writeReason,
          contextQuery: sql.trim() || undefined,
        }),
      });
      setWriteSql(''); setWriteReason(''); setShowWriteForm(false);
      loadRequests();
      alert('Pedido registrado — um aprovador (N2/N3) vai revisar e executar.');
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'erro ao registrar pedido');
    }
  }

  async function approve(id: string) {
    if (!confirm('Aprovar este pedido EXECUTA o SQL agora, dentro de uma transação. Confirmar?')) return;
    try {
      await apiFetch(`/db-access/requests/${id}/approve`, { method: 'POST', body: '{}' });
      loadRequests();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'erro ao aprovar/executar');
      loadRequests();
    }
  }
  async function reject(id: string) {
    await apiFetch(`/db-access/requests/${id}/reject`, { method: 'POST', body: '{}' });
    loadRequests();
  }

  return (
    <AppShell>
      <div className="p-6 space-y-3">
        <PageHeader
          title="Acesso a banco (Zero Trust)"
          description="Leitura é direta. Qualquer UPDATE/INSERT/DELETE precisa de pedido aprovado — quem aprova é quem executa, em sessão auditada."
          icon={<TerminalSquare size={16} />}
        />

        <Card className="p-4 grid md:grid-cols-4 gap-2 items-end">
          <div>
            <label className="text-xs text-muted">Cluster</label>
            <Select value={clusterId} onChange={(e) => setClusterId(e.target.value)}>
              <option value="">—</option>
              {safeArray<Cluster>(clusters).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted">Database</label>
            <Select
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              disabled={!clusterId || loadingDatabases}
            >
              <option value="">
                {!clusterId
                  ? 'selecione um cluster primeiro'
                  : loadingDatabases
                    ? 'carregando…'
                    : `padrão do cluster (${clusters.find((c) => c.id === clusterId)?.database ?? '—'})`}
              </option>
              {databases.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </Select>
          </div>
        </Card>

        {canQuery && (
          <Card className="p-4 space-y-2">
            <label className="text-xs text-muted">SELECT / WITH (leitura — sem aprovação)</label>
            <textarea
              value={sql} onChange={(e) => setSql(e.target.value)}
              rows={4}
              className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm font-mono"
              placeholder="SELECT * FROM ..."
            />
            <div className="flex gap-2">
              <Button onClick={runQuery} disabled={running}>{running ? 'Executando…' : 'Executar'}</Button>
              {canWriteRequest && (
                <Button variant="secondary" onClick={() => setShowWriteForm((v) => !v)}>
                  {showWriteForm ? 'cancelar pedido de escrita' : 'preciso de um UPDATE/INSERT/DELETE…'}
                </Button>
              )}
            </div>
            {queryError && <div className="text-xs text-danger">{queryError}</div>}
            {result && (
              <div className="text-xs text-muted">
                {result.rowCount} linha(s) · {result.tookMs}ms {result.truncated && '· (amostra limitada a 500 linhas)'}
              </div>
            )}
            {result && result.rows.length > 0 && (
              <div className="overflow-auto max-h-96 border border-border rounded-md">
                <table className="w-full text-xs">
                  <thead className="bg-panel2 sticky top-0">
                    <tr>
                      {Object.keys(result.rows[0]).map((k) => (
                        <th key={k} className="text-left px-2 py-1 font-mono">{k}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i} className="border-t border-border">
                        {Object.keys(result.rows[0]).map((k) => (
                          <td key={k} className="px-2 py-1 font-mono whitespace-nowrap">{String(row[k] ?? '')}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {showWriteForm && canWriteRequest && (
          <Card className="p-4 space-y-2 border-warn/40">
            <div className="text-sm font-medium">Pedido de escrita (UPDATE/INSERT/DELETE)</div>
            <label className="text-xs text-muted">SQL de escrita</label>
            <textarea
              value={writeSql} onChange={(e) => setWriteSql(e.target.value)}
              rows={3}
              className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm font-mono"
              placeholder="UPDATE ... SET ... WHERE ..."
            />
            <label className="text-xs text-muted">Motivo (vai pro aprovador, junto do SELECT acima como contexto)</label>
            <Input value={writeReason} onChange={(e) => setWriteReason(e.target.value)} placeholder="ex: corrigir status travado do pedido #1234" />
            <Button onClick={submitWriteRequest}>Enviar pedido para aprovação</Button>
          </Card>
        )}

        <Card className="p-0">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-sm font-medium">Pedidos de escrita</span>
            <label className="flex items-center gap-1 text-xs text-muted">
              <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
              só pendentes
            </label>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-xs uppercase text-muted">
              <tr>
                <th className="text-left px-3 py-2">Quando</th>
                <th className="text-left px-3 py-2">Cluster</th>
                <th className="text-left px-3 py-2">Solicitante</th>
                <th className="text-left px-3 py-2">SQL</th>
                <th className="text-left px-3 py-2">Motivo</th>
                <th className="text-left px-3 py-2">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {safeArray<ReqRow>(requests).filter((r) => r.kind === 'write').map((r) => (
                <tr key={r.id} className="border-t border-border align-top">
                  <td className="px-3 py-1.5 text-xs text-muted whitespace-nowrap">{fmtTime(r.created_at)}</td>
                  <td className="px-3 py-1.5 text-xs">{r.cluster_name}{r.database ? ` / ${r.database}` : ''}</td>
                  <td className="px-3 py-1.5 text-xs">{r.requested_by_email}</td>
                  <td className="px-3 py-1.5 text-xs font-mono max-w-xs truncate" title={r.sql_text}>{r.sql_text}</td>
                  <td className="px-3 py-1.5 text-xs text-muted max-w-xs truncate" title={r.reason}>{r.reason}</td>
                  <td className="px-3 py-1.5">
                    <Badge tone={STATUS_TONE[r.status] ?? 'default'}>{r.status}</Badge>
                    {r.status === 'executed' && r.row_count != null && (
                      <div className="text-[10px] text-muted mt-0.5">{r.row_count} linha(s) afetada(s)</div>
                    )}
                    {r.error_text && <div className="text-[10px] text-danger mt-0.5">{r.error_text}</div>}
                  </td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap space-x-2">
                    {r.status === 'pending' && canApprove && (
                      <>
                        <button onClick={() => approve(r.id)} className="text-success hover:underline text-xs">aprovar e executar</button>
                        <button onClick={() => reject(r.id)} className="text-danger hover:underline text-xs">rejeitar</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {!requests.filter((r) => r.kind === 'write').length && (
                <tr><td colSpan={7} className="px-3 py-4 text-center text-muted text-xs">nenhum pedido de escrita ainda</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </AppShell>
  );
}
