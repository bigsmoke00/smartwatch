'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { DataTable, THeadRow, Th, Tr, Td } from '@/components/ui/Table';
import { apiFetch, ApiError } from '@/lib/api';
import { loadMyPermissions, hasPerm } from '@/lib/perms';
import { fmtTime, safeArray } from '@/lib/utils';
import { TerminalSquare } from 'lucide-react';

// Monaco é client-only — carrega via dynamic import (mesmo padrão do Script Manager)
const Editor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), { ssr: false });

/**
 * Quebra o texto do editor em instruções separadas por ";", guardando o
 * range [start,end) de cada uma no texto original — usado pra descobrir em
 * qual instrução o cursor está (sem precisar apagar/reescrever pra rodar só
 * uma, tipo Metabase/DBeaver). Split simples por ";" é suficiente pro nosso
 * caso (SQL ad-hoc de análise); não tenta lidar com ";" dentro de strings.
 */
function splitStatements(sqlText: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < sqlText.length; i++) {
    if (sqlText[i] === ';') {
      out.push({ text: sqlText.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  if (start <= sqlText.length) out.push({ text: sqlText.slice(start), start, end: sqlText.length });
  return out;
}

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
  // instrução "ativa" (sob o cursor, ou selecionada) — é só ela que roda ao
  // clicar Executar/Ctrl+Enter, mesmo com várias instruções no editor.
  const [activeStatement, setActiveStatement] = useState('');
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const decorationsRef = useRef<string[]>([]);
  const runQueryRef = useRef<() => void>(() => {});

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

  /** Descobre qual instrução deve rodar: texto selecionado tem prioridade;
   * senão, a instrução (separada por ";") onde o cursor está. */
  function computeActiveStatement(): { text: string; range: any | null } {
    const editor = editorRef.current;
    if (!editor) return { text: sql, range: null };
    const model = editor.getModel();
    if (!model) return { text: sql, range: null };
    const sel = editor.getSelection();
    const selectedText = sel ? model.getValueInRange(sel) : '';
    if (selectedText.trim()) return { text: selectedText, range: sel };
    const pos = editor.getPosition();
    const offset = pos ? model.getOffsetAt(pos) : model.getValue().length;
    const stmts = splitStatements(model.getValue()).filter((s) => s.text.trim());
    if (!stmts.length) return { text: '', range: null };
    const cur = stmts.find((s) => offset >= s.start && offset <= s.end) ?? stmts[stmts.length - 1];
    const monacoNS = monacoRef.current;
    const startPos = model.getPositionAt(cur.start);
    const endPos = model.getPositionAt(cur.end);
    const range = monacoNS ? new monacoNS.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column) : null;
    return { text: cur.text, range };
  }

  function highlightActiveStatement() {
    const editor = editorRef.current;
    if (!editor) return;
    const { text, range } = computeActiveStatement();
    setActiveStatement(text.trim());
    decorationsRef.current = editor.deltaDecorations(
      decorationsRef.current,
      range ? [{ range, options: { inlineClassName: 'sql-active-stmt' } }] : [],
    );
  }

  function handleEditorMount(editor: any, monacoNS: any) {
    editorRef.current = editor;
    monacoRef.current = monacoNS;
    editor.onDidChangeCursorPosition(() => highlightActiveStatement());
    editor.onDidChangeModelContent(() => highlightActiveStatement());
    // Ctrl/Cmd+Enter roda a instrução ativa, sem precisar tirar a mão do teclado.
    editor.addCommand(monacoNS.KeyMod.CtrlCmd | monacoNS.KeyCode.Enter, () => runQueryRef.current());
    highlightActiveStatement();
  }

  async function runQuery() {
    const toRun = (computeActiveStatement().text || sql).trim();
    if (!clusterId || !toRun) return alert('selecione um cluster e informe o SQL');
    setRunning(true); setQueryError(null); setResult(null);
    try {
      const r = await apiFetch<QueryResult>('/db-access/query', {
        method: 'POST',
        body: JSON.stringify({ clusterId, database: database.trim() || undefined, sql: toRun }),
      });
      setResult(r);
    } catch (e) {
      setQueryError(e instanceof ApiError ? e.message : 'erro ao executar');
    } finally {
      setRunning(false);
    }
  }
  runQueryRef.current = runQuery;

  async function submitWriteRequest() {
    if (!clusterId || !writeSql.trim() || !writeReason.trim()) {
      return alert('selecione um cluster, informe o SQL de escrita e o motivo');
    }
    try {
      await apiFetch('/db-access/requests', {
        method: 'POST',
        body: JSON.stringify({
          clusterId, database: database.trim() || undefined, sql: writeSql, reason: writeReason,
          contextQuery: (activeStatement || sql).trim() || undefined,
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
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="Acesso a banco (Zero Trust)"
          description="Leitura é direta. Qualquer UPDATE/INSERT/DELETE precisa de pedido aprovado — quem aprova é quem executa, em sessão auditada."
          icon={<TerminalSquare size={16} />}
        />

        <div className="text-info bg-info/[0.08] border border-info/30 rounded-lg px-3 py-2 text-[13px]">
          SELECT/WITH roda direto (com cap de linhas e timeout). Qualquer escrita (UPDATE/INSERT/DELETE) exige aprovação de outra pessoa — quem aprova é quem executa.
        </div>

        <Card className="p-4 grid md:grid-cols-4 gap-3 items-end">
          <div>
            <label className="text-2xs uppercase tracking-wider text-mutedFaint">Cluster</label>
            <Select className="mt-1" value={clusterId} onChange={(e) => setClusterId(e.target.value)}>
              <option value="">—</option>
              {safeArray<Cluster>(clusters).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-2xs uppercase tracking-wider text-mutedFaint">Database</label>
            <Select
              className="mt-1"
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
          <>
            <div className="grid lg:grid-cols-3 gap-4 items-start">
            <Card className="lg:col-span-2 p-0 overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
                <div className="min-w-0">
                  <div className="font-mono text-[13px] text-text truncate">
                    {clusters.find((c) => c.id === clusterId)?.name ?? 'selecione um cluster'}
                    {database ? ` / ${database}` : ''}
                  </div>
                  <div className="text-2xs uppercase tracking-wider text-mutedFaint mt-0.5">
                    SELECT / WITH (leitura — sem aprovação)
                  </div>
                </div>
                <Button onClick={runQuery} disabled={running}>{running ? 'Executando…' : 'Executar'}</Button>
              </div>
              <div className="p-4 space-y-2">
                <div className="text-2xs text-mutedFaint">
                  várias instruções separadas por <code className="font-mono text-muted">;</code> — o cursor escolhe qual roda (ou selecione um trecho) · Ctrl+Enter executa
                </div>
                <div className="rounded-md border border-border overflow-hidden" style={{ height: 220 }}>
                  <Editor
                    language="sql"
                    theme="vs-dark"
                    value={sql}
                    onChange={(v) => setSql(v ?? '')}
                    onMount={handleEditorMount}
                    options={{
                      fontSize: 13, minimap: { enabled: false }, automaticLayout: true,
                      scrollBeyondLastLine: false, renderWhitespace: 'selection', lineNumbers: 'on',
                    }}
                  />
                </div>
                {activeStatement && (
                  <div className="text-2xs text-muted truncate">
                    vai executar: <span className="font-mono text-text">{activeStatement}</span>
                  </div>
                )}
                {canWriteRequest && (
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => setShowWriteForm((v) => !v)}>
                      {showWriteForm ? 'cancelar pedido de escrita' : 'preciso de um UPDATE/INSERT/DELETE…'}
                    </Button>
                  </div>
                )}
                {queryError && <div className="text-xs text-danger">{queryError}</div>}
              </div>
            </Card>
            <SchemaPanel clusterId={clusterId} database={database} onUseTable={setSql} />
            </div>

            {result && (
              <Card className="p-0 overflow-hidden">
                <div className="px-[18px] py-2.5 border-b border-border text-2xs uppercase tracking-wider text-mutedFaint font-mono">
                  {result.rowCount} linha(s) · {result.tookMs}ms {result.truncated && '· (amostra limitada a 500 linhas)'}
                </div>
                {result.rows.length > 0 && (
                  <div className="overflow-auto max-h-96">
                    <DataTable className="!border-0 !rounded-none !bg-transparent !overflow-visible">
                      <THeadRow>
                        {Object.keys(result.rows[0]).map((k) => (
                          <Th key={k} className="normal-case font-mono">{k}</Th>
                        ))}
                      </THeadRow>
                      <tbody>
                        {result.rows.map((row, i) => (
                          <Tr key={i}>
                            {Object.keys(result.rows[0]).map((k) => (
                              <Td key={k} className="font-mono whitespace-nowrap">{String(row[k] ?? '')}</Td>
                            ))}
                          </Tr>
                        ))}
                      </tbody>
                    </DataTable>
                  </div>
                )}
              </Card>
            )}
          </>
        )}

        {showWriteForm && canWriteRequest && (
          <Card className="p-4 space-y-2 border-warn/40">
            <div className="flex items-center gap-2">
              <Badge tone="warn">escrita</Badge>
              <span className="text-sm font-medium text-text">Pedido de escrita (UPDATE/INSERT/DELETE)</span>
            </div>
            <label className="text-2xs uppercase tracking-wider text-mutedFaint">SQL de escrita</label>
            <textarea
              value={writeSql} onChange={(e) => setWriteSql(e.target.value)}
              rows={3}
              className="w-full rounded-lg bg-panel2 border border-border px-3 py-2 text-sm font-mono text-text placeholder:text-mutedFaint transition-colors focus:outline-none focus:ring-2 focus:ring-accent/35 focus:border-accent/60"
              placeholder="UPDATE ... SET ... WHERE ..."
            />
            <label className="text-2xs uppercase tracking-wider text-mutedFaint">Motivo (vai pro aprovador, junto do SELECT acima como contexto)</label>
            <Input value={writeReason} onChange={(e) => setWriteReason(e.target.value)} placeholder="ex: corrigir status travado do pedido #1234" />
            <Button onClick={submitWriteRequest}>Enviar pedido para aprovação</Button>
          </Card>
        )}

        <Card className="p-0 overflow-hidden">
          <div className="flex items-center justify-between px-[18px] py-3 border-b border-border">
            <span className="text-sm font-medium text-text">Pedidos de escrita</span>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} className="accent-accent" />
              só pendentes
            </label>
          </div>
          <DataTable className="!border-0 !rounded-none !bg-transparent">
            <THeadRow>
              <Th>Quando</Th>
              <Th>Cluster</Th>
              <Th>Solicitante</Th>
              <Th>SQL</Th>
              <Th>Motivo</Th>
              <Th>Status</Th>
              <Th />
            </THeadRow>
            <tbody>
              {safeArray<ReqRow>(requests).filter((r) => r.kind === 'write').map((r) => (
                <Tr key={r.id} className="align-top">
                  <Td className="font-mono text-mutedFaint whitespace-nowrap">{fmtTime(r.created_at)}</Td>
                  <Td>{r.cluster_name}{r.database ? ` / ${r.database}` : ''}</Td>
                  <Td className="text-accentSoft">{r.requested_by_email}</Td>
                  <Td className="font-mono max-w-xs truncate" title={r.sql_text}>{r.sql_text}</Td>
                  <Td className="text-muted max-w-xs truncate" title={r.reason}>{r.reason}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[r.status] ?? 'default'}>{r.status}</Badge>
                    {r.status === 'executed' && r.row_count != null && (
                      <div className="text-[10px] text-muted mt-0.5">{r.row_count} linha(s) afetada(s)</div>
                    )}
                    {r.error_text && <div className="text-[10px] text-danger mt-0.5">{r.error_text}</div>}
                  </Td>
                  <Td className="text-right whitespace-nowrap space-x-3">
                    {r.status === 'pending' && canApprove && (
                      <>
                        <button onClick={() => approve(r.id)} className="text-success hover:underline text-xs font-medium">aprovar e executar</button>
                        <button onClick={() => reject(r.id)} className="text-danger hover:underline text-xs font-medium">rejeitar</button>
                      </>
                    )}
                  </Td>
                </Tr>
              ))}
              {!requests.filter((r) => r.kind === 'write').length && (
                <Tr><Td colSpan={7} className="py-6 text-center text-muted text-xs">nenhum pedido de escrita ainda</Td></Tr>
              )}
            </tbody>
          </DataTable>
        </Card>
      </div>
    </AppShell>
  );
}

interface SchemaColumn { name: string; type: string; notnull: boolean; pk: boolean }
interface SchemaTable {
  schema: string; name: string; kind: 'table' | 'view' | 'matview';
  estRows: number | null; columns: SchemaColumn[];
}

/**
 * Painel lateral com o schema do database escolhido — tabelas, colunas, tipo,
 * PK e uma estimativa de linhas — pra ajudar a montar o SELECT. O botão
 * "SELECT" preenche o editor com um SELECT já pronto daquela tabela.
 */
function SchemaPanel({
  clusterId, database, onUseTable,
}: { clusterId: string; database: string; onUseTable: (sql: string) => void }) {
  const [tables, setTables] = useState<SchemaTable[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!clusterId) { setTables([]); return; }
    setLoading(true); setError(null); setOpen(null);
    const qs = database ? `?database=${encodeURIComponent(database)}` : '';
    apiFetch<SchemaTable[]>(`/db-access/clusters/${clusterId}/schema${qs}`)
      .then((r) => setTables(safeArray<SchemaTable>(r)))
      .catch((e: any) => setError(e?.payload?.message || e?.message || 'erro ao carregar schema'))
      .finally(() => setLoading(false));
  }, [clusterId, database]);

  const q = filter.trim().toLowerCase();
  const shown = q
    ? tables.filter((t) =>
        `${t.schema}.${t.name}`.toLowerCase().includes(q) ||
        t.columns.some((c) => c.name.toLowerCase().includes(q)))
    : tables;

  const ident = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s}"`);
  const fqn = (t: SchemaTable) =>
    t.schema === 'public' ? ident(t.name) : `${ident(t.schema)}.${ident(t.name)}`;
  function buildSelect(t: SchemaTable) {
    const cols =
      t.columns.length && t.columns.length <= 40
        ? t.columns.map((c) => ident(c.name)).join(', ')
        : '*';
    onUseTable(`SELECT ${cols}\nFROM ${fqn(t)}\nLIMIT 100;`);
  }

  return (
    <Card className="p-0 overflow-hidden self-start">
      <div className="px-3 py-2.5 border-b border-border flex items-center gap-2">
        <span className="text-[13px] font-semibold">Tabelas</span>
        {!!tables.length && <span className="ml-auto text-2xs text-mutedFaint tabular-nums">{tables.length}</span>}
      </div>
      <div className="p-2 border-b border-border">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filtrar tabela ou coluna…"
          className="w-full bg-bg border border-border rounded-md px-2 py-1.5 text-xs text-text placeholder:text-mutedFaint outline-none focus:border-accent/60"
        />
      </div>
      <div className="max-h-[460px] overflow-auto">
        {!clusterId && <div className="p-3 text-xs text-muted">Escolha um cluster e um database.</div>}
        {clusterId && loading && <div className="p-3 text-xs text-muted">carregando schema…</div>}
        {error && <div className="p-3 text-xs text-warn">{error}</div>}
        {clusterId && !loading && !error && shown.length === 0 && (
          <div className="p-3 text-xs text-muted">Nenhuma tabela encontrada.</div>
        )}
        {shown.map((t) => {
          const key = `${t.schema}.${t.name}`;
          const isOpen = open === key;
          return (
            <div key={key} className="border-b border-border/50 last:border-0">
              <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-panel2/50">
                <button
                  onClick={() => setOpen(isOpen ? null : key)}
                  className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
                >
                  <span className="text-mutedFaint text-2xs w-3 shrink-0">{isOpen ? '▾' : '▸'}</span>
                  <span className="font-mono text-xs truncate">{t.schema === 'public' ? t.name : key}</span>
                  {t.kind !== 'table' && <span className="text-2xs text-mutedFaint shrink-0">{t.kind}</span>}
                </button>
                {t.estRows != null && (
                  <span className="text-2xs text-mutedFaint tabular-nums shrink-0" title="linhas estimadas (último ANALYZE)">
                    ~{t.estRows.toLocaleString()}
                  </span>
                )}
                <button
                  onClick={() => buildSelect(t)}
                  title="Gerar SELECT desta tabela no editor"
                  className="text-2xs text-accentSoft hover:underline shrink-0"
                >
                  SELECT
                </button>
              </div>
              {isOpen && (
                <div className="px-3 pb-2 pl-6 space-y-0.5">
                  {t.columns.map((c) => (
                    <div key={c.name} className="flex items-center gap-2 text-2xs font-mono">
                      <span className={`w-4 shrink-0 ${c.pk ? 'text-warn' : 'text-transparent'}`} title={c.pk ? 'chave primária' : undefined}>PK</span>
                      <span className="text-text truncate">{c.name}</span>
                      <span className="text-mutedFaint ml-auto shrink-0">
                        {c.type}{c.notnull ? ' · NN' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
