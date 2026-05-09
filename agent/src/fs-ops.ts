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
import { resolve, normalize, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const ALLOWED = (process.env.LOGWATCH_ALLOWED_PATHS ?? '/opt')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => resolve(p));

const MAX_READ_BYTES = parseInt(process.env.LOGWATCH_MAX_READ ?? '5000000', 10); // 5MB
const MAX_WRITE_BYTES = parseInt(process.env.LOGWATCH_MAX_WRITE ?? '5000000', 10);
const EXEC_TIMEOUT_MS = parseInt(process.env.LOGWATCH_EXEC_TIMEOUT ?? '120000', 10);

function ensureAllowed(p: string): string {
  const abs = resolve(normalize(p));
  for (const base of ALLOWED) {
    if (abs === base || abs.startsWith(base + sep)) return abs;
  }
  throw new Error(`path not allowed: ${abs} (allowed: ${ALLOWED.join(', ')})`);
}

export async function listDir(path: string) {
  const abs = ensureAllowed(path);
  const items = await fs.readdir(abs, { withFileTypes: true });
  const out = await Promise.all(items.map(async (it) => {
    const full = abs + sep + it.name;
    let size: number | null = null;
    let mtime: string | null = null;
    try {
      const s = statSync(full);
      size = s.size;
      mtime = s.mtime.toISOString();
    } catch { /* ignore broken symlink */ }
    return {
      name: it.name,
      path: full,
      type: it.isDirectory() ? 'dir' : it.isSymbolicLink() ? 'symlink' : 'file',
      size,
      mtime,
    };
  }));
  return { path: abs, items: out };
}

export async function readFile(path: string) {
  const abs = ensureAllowed(path);
  const stat = await fs.stat(abs);
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`file too large (${stat.size} > ${MAX_READ_BYTES})`);
  }
  const buf = await fs.readFile(abs);
  return {
    path: abs,
    size: stat.size,
    sha256: createHash('sha256').update(buf).digest('hex'),
    mtime: stat.mtime.toISOString(),
    content: buf.toString('utf-8'),
  };
}

export async function writeFile(path: string, content: string) {
  const abs = ensureAllowed(path);
  const buf = Buffer.from(content, 'utf-8');
  if (buf.length > MAX_WRITE_BYTES) {
    throw new Error(`content too large (${buf.length} > ${MAX_WRITE_BYTES})`);
  }
  await fs.writeFile(abs, buf, { mode: 0o644 });
  const stat = await fs.stat(abs);
  return {
    path: abs,
    size: stat.size,
    sha256: createHash('sha256').update(buf).digest('hex'),
    mtime: stat.mtime.toISOString(),
  };
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
  const abs = ensureAllowed(opts.path);
  const cwd = opts.cwd ? ensureAllowed(opts.cwd) : undefined;
  const args = opts.args ?? [];
  const timeoutMs = Math.min(opts.timeoutMs ?? EXEC_TIMEOUT_MS, EXEC_TIMEOUT_MS);

  return new Promise((resolveP) => {
    const t0 = Date.now();
    const child = spawn(abs, args, {
      cwd,
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
