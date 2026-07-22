'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { AppShell } from '@/components/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { ServerPicker } from '@/components/ServerPicker';
import { useServers } from '@/lib/useServers';
import { apiFetch } from '@/lib/api';
import { loadMyPermissions, hasPerm } from '@/lib/perms';
import { fmtTime, safeArray } from '@/lib/utils';
import {
  Folder, FileText, Save, Play, Download, Upload, History, ArrowUp, RefreshCw, FolderOpen, Code2, Lock, Trash2,
} from 'lucide-react';

// Monaco é client-only — carrega via dynamic import
const Editor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), { ssr: false });

interface FsItem {
  name: string; path: string; type: 'dir' | 'file' | 'symlink';
  size: number | null; mtime: string | null;
  lastEditor?: string | null; lastEditedAt?: string | null;
}
interface FileResp {
  path: string; size: number; sha256: string; mtime: string; content: string;
  lastEditor?: string | null; lastEditedAt?: string | null; lastComment?: string | null;
}
interface Version {
  id: string; ts: string; authorEmail?: string; sha256: string; comment?: string;
}

export default function ScriptsPage() {
  const { servers } = useServers();
  const [serverId, setServerId] = useState<string>('');
  const [path, setPath] = useState<string>('/');
  const [items, setItems] = useState<FsItem[]>([]);
  const [file, setFile] = useState<FileResp | null>(null);
  const [content, setContent] = useState<string>('');
  const [versions, setVersions] = useState<Version[]>([]);
  const [executions, setExecutions] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [perms, setPerms] = useState<Set<string> | null>(null);
  useEffect(() => { loadMyPermissions().then(setPerms); }, []);
  const canWrite = hasPerm(perms, 'scripts:write');
  const canExecute = hasPerm(perms, 'scripts:execute');
  const canDelete = hasPerm(perms, 'scripts:delete');
  // Modo leitura: só consegue ver (scripts:read), sem editar/executar/apagar.
  const readOnly = perms !== null && !canWrite && !canExecute && !canDelete;

  const dirty = file && content !== file.content;

  // ---- listar diretório
  async function loadDir(p: string) {
    if (!serverId) return;
    setError(null);
    setLoading(true);
    try {
      const r: any = await apiFetch(`/scripts/${serverId}/ls?path=${encodeURIComponent(p)}`);
      setItems(safeArray<FsItem>(r?.items));
      setPath(r?.path ?? p);
      setFile(null);
      setContent('');
    } catch (e: any) {
      setError(e?.payload?.message || e.message);
      setItems([]);
    } finally { setLoading(false); }
  }
  useEffect(() => { if (serverId) loadDir(path); /* eslint-disable-next-line */ }, [serverId]);

  // ---- carregar arquivo
  async function openFile(p: string) {
    setError(null);
    setLoading(true);
    try {
      const r = await apiFetch<FileResp>(`/scripts/${serverId}/file?path=${encodeURIComponent(p)}`);
      setFile(r);
      setContent(r.content);
      const v = await apiFetch<Version[]>(`/scripts/${serverId}/versions?path=${encodeURIComponent(p)}`).catch(() => []);
      setVersions(safeArray<Version>(v));
    } catch (e: any) {
      setError(e?.payload?.message || e.message);
    } finally { setLoading(false); }
  }

  async function save(comment?: string) {
    if (!file) return;
    setLoading(true);
    try {
      await apiFetch(`/scripts/${serverId}/file`, {
        method: 'POST',
        body: JSON.stringify({ path: file.path, content, comment }),
      });
      await openFile(file.path);
    } catch (e: any) {
      setError(e?.payload?.message || e.message);
    } finally { setLoading(false); }
  }

  async function deleteFile() {
    if (!file) return;
    if (!confirm(`Apagar o arquivo ${file.path}? Esta ação não pode ser desfeita.`)) return;
    setLoading(true);
    try {
      await apiFetch(`/scripts/${serverId}/file?path=${encodeURIComponent(file.path)}`, { method: 'DELETE' });
      setFile(null); setContent(''); setVersions([]);
      await loadDir(path);
    } catch (e: any) {
      setError(e?.payload?.message || e.message);
    } finally { setLoading(false); }
  }

  async function execute() {
    if (!file) return;
    if (!confirm(`Executar ${file.path}?`)) return;
    try {
      const r: any = await apiFetch(`/scripts/${serverId}/execute`, {
        method: 'POST', body: JSON.stringify({ path: file.path }),
      });
      if (r?.requiresApproval) {
        alert('Servidor de produção: execução criada como PENDING. Peça aprovação a alguém com scripts:approve.');
      }
      loadExecutions();
    } catch (e: any) {
      setError(e?.payload?.message || e.message);
    }
  }

  async function loadExecutions() {
    setExecutions(safeArray<any>(await apiFetch(`/scripts/${serverId}/executions`).catch(() => [])));
  }
  useEffect(() => { if (serverId) loadExecutions(); }, [serverId]);

  async function approve(id: string) {
    await apiFetch(`/scripts/${serverId}/executions/${id}/approve`, { method: 'POST', body: '{}' });
    loadExecutions();
  }
  async function reject(id: string) {
    await apiFetch(`/scripts/${serverId}/executions/${id}/reject`, { method: 'POST', body: '{}' });
    loadExecutions();
  }

  function downloadCurrent() {
    if (!file) return;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.path.split('/').pop() ?? 'file.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  function uploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f || !file) return;
    const reader = new FileReader();
    reader.onload = () => setContent(String(reader.result ?? ''));
    reader.readAsText(f);
  }

  const parent = useMemo(() => path.replace(/\/[^/]+$/, '') || '/', [path]);
  const env = servers.find((s) => s.id === serverId)?.environment;

  return (
    <AppShell>
      <div className="p-[22px] space-y-4">
        <PageHeader
          title="Script Manager"
          description="Edição, versionamento e execução de scripts no host — produção exige aprovação."
          icon={<Code2 size={16} />}
          actions={
            <div className="flex items-center gap-2">
              <ServerPicker
                value={serverId}
                onChange={setServerId}
                className="flex items-center gap-2"
                selectClassName="w-auto"
                autoSelectFirst
              />
              {env && (
                <Badge tone={env === 'production' ? 'danger' : 'info'}>
                  {env}
                </Badge>
              )}
            </div>
          }
        />

        {readOnly && (
          <div className="rounded-xl border border-warn/50 bg-warn/10 px-4 py-3 flex items-center gap-3">
            <Lock size={22} className="text-warn shrink-0" />
            <div>
              <div className="text-warn font-semibold text-base">Modo somente leitura</div>
              <div className="text-sm text-muted">
                Você pode visualizar os scripts, mas <strong>não pode editar, executar nem apagar</strong> nada.
                Peça a um administrador a permissão adequada (scripts:write, scripts:execute ou scripts:delete).
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-12 gap-4">
          {/* TREE */}
          <Card className="col-span-3 p-0 overflow-hidden">
            <div className="px-3 pt-3 pb-2 flex items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-muted">
              <Folder size={13} className="text-accent" /> Scripts
            </div>
            <div className="px-3 pb-2.5 flex items-center gap-2 border-b border-border">
              <button onClick={() => loadDir(parent)} className="text-muted hover:text-text transition-colors" title="parent">
                <ArrowUp size={14} />
              </button>
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadDir(path)}
                className="h-7 text-xs font-mono"
              />
              <button onClick={() => loadDir(path)} className="text-muted hover:text-text transition-colors" title="reload">
                <RefreshCw size={14} />
              </button>
            </div>
            <div className="max-h-[70vh] overflow-auto">
              {safeArray<FsItem>(items).map((it) => {
                const Icon = it.type === 'dir' ? Folder : FileText;
                const editorLabel = it.lastEditor
                  ? `por ${it.lastEditor}${it.lastEditedAt ? ' em ' + fmtTime(it.lastEditedAt) : ''}`
                  : '';
                const active = it.type !== 'dir' && file?.path === it.path;
                return (
                  <button
                    key={it.path}
                    title={editorLabel || (it.mtime ? `mtime: ${fmtTime(it.mtime)}` : '')}
                    onClick={() => it.type === 'dir' ? loadDir(it.path) : openFile(it.path)}
                    className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2.5 border-l-2 transition-colors ${
                      active ? 'border-accent bg-accent/[0.06]' : 'border-transparent hover:bg-panel2'
                    }`}
                  >
                    <Icon size={14} className={it.type === 'dir' ? 'text-accent shrink-0' : active ? 'text-accentSoft shrink-0' : 'text-muted shrink-0'} />
                    <span className="flex-1 min-w-0">
                      <span className={`block truncate ${active ? 'text-text' : ''}`}>{it.name}</span>
                      {it.lastEditor && (
                        <span className="block text-2xs text-muted truncate" title={editorLabel}>
                          {it.lastEditor.split('@')[0]}{it.lastEditedAt ? ' · ' + fmtTime(it.lastEditedAt) : ''}
                        </span>
                      )}
                    </span>
                    {it.size != null && it.type !== 'dir' && (
                      <span className="text-2xs text-mutedFaint font-mono shrink-0">{fmtBytes(it.size)}</span>
                    )}
                  </button>
                );
              })}
              {items.length === 0 && !loading && (
                <div className="px-3 py-4 text-sm text-muted">Diretório vazio.</div>
              )}
            </div>
          </Card>

          {/* EDITOR */}
          <Card className="col-span-9 p-0 overflow-hidden">
            <div className="px-3 py-2 bg-panel2 border-b border-border flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <FileText size={14} className="text-muted shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-mono truncate flex items-center gap-2">
                    <span className="truncate">{file ? file.path : 'selecione um arquivo'}</span>
                    {dirty && <span className="text-warn shrink-0" title="alterado, não salvo">●</span>}
                    {file && env === 'production' && <Badge tone="warn">PROD</Badge>}
                  </div>
                  {file?.lastEditor && (
                    <div className="text-[11px] text-muted font-sans truncate">
                      Última edição por <span className="text-accent">{file.lastEditor}</span>
                      {file.lastEditedAt && <> em {fmtTime(file.lastEditedAt)}</>}
                      {file.lastComment && <> — “{file.lastComment}”</>}
                    </div>
                  )}
                </div>
              </div>
              {file && (
                <div className="flex items-center gap-2 shrink-0">
                  <input ref={fileInputRef} type="file" onChange={uploadFile} className="hidden" />
                  {canWrite && (
                    <Button variant="ghost" size="icon" onClick={() => fileInputRef.current?.click()} title="Upload (substitui editor)">
                      <Upload size={14} />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" onClick={downloadCurrent} title="Download">
                    <Download size={14} />
                  </Button>
                  {canWrite && (
                    <Button variant="secondary" onClick={() => save(prompt('Comentário?') ?? undefined)} disabled={!dirty}>
                      <Save size={14} /> Salvar
                    </Button>
                  )}
                  {canDelete && (
                    <Button variant="ghost" onClick={deleteFile} title="Apagar arquivo" className="text-danger hover:bg-danger/10">
                      <Trash2 size={14} /> Apagar
                    </Button>
                  )}
                  {canExecute && (
                    <Button
                      onClick={execute}
                      variant={env === 'production' ? 'secondary' : 'primary'}
                      className={env === 'production' ? 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/20' : undefined}
                      title={env === 'production' ? 'Produção: cria execução pendente para aprovação' : 'Executar script'}
                    >
                      <Play size={14} /> {env === 'production' ? 'Pedir execução' : 'Executar'}
                    </Button>
                  )}
                </div>
              )}
            </div>
            <div className="h-[65vh]">
              {file ? (
                <Editor
                  language={guessLang(file.path)}
                  theme="vs-dark"
                  value={content}
                  onChange={(v) => setContent(v ?? '')}
                  options={{
                    fontSize: 13, minimap: { enabled: false }, automaticLayout: true,
                    scrollBeyondLastLine: false, renderWhitespace: 'selection',
                    readOnly: !canWrite, // sem scripts:write o editor é só leitura
                  }}
                />
              ) : (
                <div className="p-6 text-sm text-muted flex items-center gap-2">
                  <FolderOpen size={14} /> Navegue na árvore à esquerda e clique num arquivo.
                </div>
              )}
            </div>
            {dirty && file && (
              <DiffPanel original={file.content} current={content} />
            )}
          </Card>
        </div>

        {error && (
          <div className="text-sm text-danger px-3 py-2 bg-danger/10 border border-danger/30 rounded-lg">{error}</div>
        )}

        {/* HISTÓRICO + EXECUÇÕES */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="p-4">
            <div className="text-sm font-medium mb-3 flex items-center gap-2 text-text">
              <History size={14} className="text-accent" /> Versões
            </div>
            <div className="text-xs space-y-1">
              {safeArray<Version>(versions).map((v) => (
                <div key={v.id} className="flex justify-between gap-3 border-b border-border/70 py-1.5">
                  <span className="text-muted">{fmtTime(v.ts)}</span>
                  <span className="text-muted truncate flex-1">{v.authorEmail ?? '—'}</span>
                  <span className="font-mono text-mutedFaint">{v.sha256.slice(0, 8)}</span>
                </div>
              ))}
              {versions.length === 0 && <div className="text-muted">Sem histórico.</div>}
            </div>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-medium mb-3 text-text">Execuções recentes</div>
            <div className="text-xs space-y-1">
              {safeArray<any>(executions).map((e) => (
                <div key={e.id} className="border-b border-border/70 py-1.5 flex items-center gap-2">
                  <span className="text-muted">{fmtTime(e.ts)}</span>
                  <span className="font-mono text-muted truncate flex-1">{e.path}</span>
                  <Badge
                    tone={
                      e.status === 'succeeded' ? 'success' :
                      e.status === 'failed'    ? 'danger' :
                      e.status === 'pending'   ? 'warn'    : 'default'
                    }
                  >
                    {e.status}
                  </Badge>
                  {e.status === 'pending' && (
                    <>
                      <button onClick={() => approve(e.id)} className="text-success hover:underline">
                        aprovar
                      </button>
                      <button onClick={() => reject(e.id)} className="text-danger hover:underline">
                        rejeitar
                      </button>
                    </>
                  )}
                </div>
              ))}
              {executions.length === 0 && <div className="text-muted">Sem execuções.</div>}
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function DiffPanel({ original, current }: { original: string; current: string }) {
  const lines = useMemo(() => {
    const a = original.split('\n');
    const b = current.split('\n');
    const max = Math.max(a.length, b.length);
    const out: { type: 'eq' | 'rem' | 'add'; text: string; n?: number }[] = [];
    // Diff linha-a-linha simples (suficiente pra preview)
    for (let i = 0; i < max; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] !== undefined) out.push({ type: 'rem', text: a[i], n: i + 1 });
      if (b[i] !== undefined) out.push({ type: 'add', text: b[i], n: i + 1 });
    }
    return out.slice(0, 200);
  }, [original, current]);
  if (!lines.length) return null;
  return (
    <div className="p-3 border-t border-border bg-bg max-h-48 overflow-auto">
      <div className="text-xs font-medium text-muted mb-1">Preview de mudanças (mostra até 200 linhas)</div>
      <pre className="text-xs font-mono">
        {lines.map((l, i) => (
          <div key={i} className={l.type === 'add' ? 'text-success' : 'text-danger'}>
            {l.type === 'add' ? '+ ' : '- '}{l.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

function guessLang(path: string) {
  const ext = path.split('.').pop()?.toLowerCase();
  return ({
    sh: 'shell', bash: 'shell', py: 'python', js: 'javascript', ts: 'typescript',
    json: 'json', yaml: 'yaml', yml: 'yaml', sql: 'sql', conf: 'ini', ini: 'ini',
    md: 'markdown', dockerfile: 'dockerfile', tf: 'hcl',
  } as Record<string, string>)[ext || ''] || 'plaintext';
}
function fmtBytes(b: number) {
  const u = ['B', 'KB', 'MB', 'GB']; let v = b; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)}${u[i]}`;
}
