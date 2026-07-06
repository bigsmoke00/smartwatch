/**
 * Operações de filesystem expostas ao backend via canal de controle.
 *
 * Segurança:
 *  - Apenas paths que casam com ALLOWED_PATHS (CSV) são acessíveis
 *  - Resolve symlinks e checa containment (impede ../ traversal)
 *  - Tamanho máximo de leitura/escrita configurável
 *  - executeScript usa spawn (sem shell) e timeout
 */
import { promises as fs, statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve, normalize, sep, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { config } from './config.js';

const HOST_ROOT = process.env.LOGWATCH_HOST_ROOT || config.hostRoot || '/host';
const HAS_HOST_ROOT = existsSync(`${HOST_ROOT}/bin`) || existsSync(`${HOST_ROOT}/etc`);
const CHROOT_BIN = process.env.LOGWATCH_CHROOT_BIN || 'chroot';

// Caminhos são sempre caminhos "virtuais" do host, ex: /opt, /etc/nginx.
// O agent traduz para /host/opt quando LOGWATCH_HOST_ROOT=/host está montado.
const ALLOWED = (process.env.LOGWATCH_ALLOWED_PATHS ?? process.env.ALLOWED_PATHS ?? '/')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => toVirtualPath(p));

const MAX_READ_BYTES = parseInt(process.env.LOGWATCH_MAX_READ ?? '5000000', 10); // 5MB
const MAX_WRITE_BYTES = parseInt(process.env.LOGWATCH_MAX_WRITE ?? '5000000', 10);
const EXEC_TIMEOUT_MS = parseInt(process.env.LOGWATCH_EXEC_TIMEOUT ?? '120000', 10);

function toVirtualPath(p: string): string {
  const n = normalize(p || '/');
  const abs = resolve('/', n);
  if (HAS_HOST_ROOT) {
    const hostRootAbs = resolve(HOST_ROOT);
    const maybeHostPath = resolve(n);
    if (maybeHostPath === hostRootAbs) return '/';
    if (maybeHostPath.startsWith(hostRootAbs + sep)) {
      return '/' + relative(hostRootAbs, maybeHostPath);
    }
  }
  return abs;
}

function toRealPath(virtualPath: string): string {
  const safe = toVirtualPath(virtualPath);
  if (!HAS_HOST_ROOT) return safe;
  return resolve(HOST_ROOT, '.' + safe);
}

function ensureAllowed(p: string): { virtualPath: string; realPath: string } {
  const abs = toVirtualPath(p);
  for (const base of ALLOWED) {
    if (base === '/' || abs === base || abs.startsWith(base + sep)) {
      return { virtualPath: abs, realPath: toRealPath(abs) };
    }
  }
  throw new Error(`path not allowed: ${abs} (allowed: ${ALLOWED.join(', ')})`);
}

export async function listDir(path: string) {
  const { virtualPath, realPath } = ensureAllowed(path);
  const items = await fs.readdir(realPath, { withFileTypes: true });
  const out = await Promise.all(items.map(async (it) => {
    const realFull = realPath + sep + it.name;
    const virtualFull = (virtualPath === '/' ? '' : virtualPath) + '/' + it.name;
    let size: number | null = null;
    let mtime: string | null = null;
    try {
      const s = statSync(realFull);
      size = s.size;
      mtime = s.mtime.toISOString();
    } catch { /* ignore broken symlink */ }
    return {
      name: it.name,
      path: virtualFull,
      type: it.isDirectory() ? 'dir' : it.isSymbolicLink() ? 'symlink' : 'file',
      size,
      mtime,
    };
  }));
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { path: virtualPath, realPath, hostRootMounted: HAS_HOST_ROOT, allowedPaths: ALLOWED, items: out };
}

export async function readFile(path: string) {
  const { virtualPath, realPath } = ensureAllowed(path);
  const stat = await fs.stat(realPath);
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`file too large (${stat.size} > ${MAX_READ_BYTES})`);
  }
  const buf = await fs.readFile(realPath);
  return {
    path: virtualPath,
    realPath,
    size: stat.size,
    sha256: createHash('sha256').update(buf).digest('hex'),
    mtime: stat.mtime.toISOString(),
    content: buf.toString('utf-8'),
  };
}

export async function writeFile(path: string, content: string) {
  const { virtualPath, realPath } = ensureAllowed(path);
  const buf = Buffer.from(content, 'utf-8');
  if (buf.length > MAX_WRITE_BYTES) {
    throw new Error(`content too large (${buf.length} > ${MAX_WRITE_BYTES})`);
  }
  await fs.writeFile(realPath, buf, { mode: 0o644 });
  const stat = await fs.stat(realPath);
  return {
    path: virtualPath,
    realPath,
    size: stat.size,
    sha256: createHash('sha256').update(buf).digest('hex'),
    mtime: stat.mtime.toISOString(),
  };
}

export async function deleteFile(path: string) {
  const { virtualPath, realPath } = ensureAllowed(path);
  const stat = await fs.stat(realPath);
  // Só apaga arquivo comum — nunca diretório (evita rm -rf acidental de árvore).
  if (!stat.isFile()) {
    throw new Error(`não é um arquivo comum: ${virtualPath}`);
  }
  await fs.unlink(realPath);
  return { path: virtualPath, realPath, deleted: true };
}

export interface ExecuteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Executa um script via spawn (sem shell). Retorna stdout/stderr capturados. */
export function executeScript(opts: {
  path: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<ExecuteResult> {
  const { virtualPath, realPath } = ensureAllowed(opts.path);
  const cwd = opts.cwd ? ensureAllowed(opts.cwd) : undefined;
  const args = opts.args ?? [];
  const timeoutMs = Math.min(opts.timeoutMs ?? EXEC_TIMEOUT_MS, EXEC_TIMEOUT_MS);

  return new Promise((resolveP) => {
    const t0 = Date.now();
    const hostCommand = `${cwd ? `cd ${shellQuote(cwd.virtualPath)} && ` : ''}${shellQuote(virtualPath)} ${args.map(shellQuote).join(' ')}`;
    const child = HAS_HOST_ROOT
      ? spawn(CHROOT_BIN, [HOST_ROOT, '/bin/sh', '-lc', hostCommand], {
        cwd: '/',
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      : spawn(realPath, args, {
      cwd: cwd?.realPath,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({
        exitCode: killed ? 124 : (code ?? -1),
        stdout: stdout.slice(0, MAX_READ_BYTES),
        stderr: stderr.slice(0, MAX_READ_BYTES),
        durationMs: Date.now() - t0,
      });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolveP({ exitCode: -1, stdout: '', stderr: e.message, durationMs: Date.now() - t0 });
    });
  });
}

function shellQuote(v: string): string {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}
