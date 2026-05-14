/**
 * Sessão de shell no HOST (não em container).
 *
 * Usa node-pty para alocar um pseudo-tty real, permitindo bash/sh
 * interativos com prompts, vim, top, etc. Diferente do exec docker (que
 * roda dentro de um container), aqui usamos o próprio processo do agent.
 *
 * IMPORTANTE: para o agent rodar comandos NO HOST e não dentro do próprio
 * container, é necessário:
 *  - rodar com `--pid host --network host` ou
 *  - bind do `/` do host num path ex: -v /:/host:rw,rslave + chroot
 *
 * Sem isso, o "host" será o próprio container do agent. Documentado no README.
 *
 * Modo readonly: prefixa toda entrada com check; se config.readonly, comandos
 * que parecem destrutivos (rm/mv/dd/...) são bloqueados ANTES de chegar no shell.
 */
import { config } from './config.js';
import { existsSync } from 'node:fs';

let ptyMod: any = null;
async function getPty() {
  if (ptyMod) return ptyMod;
  try {
    ptyMod = await import('node-pty');
    return ptyMod;
  } catch (e: any) {
    throw new Error(`node-pty não instalado/compilado: ${e.message}. Instale build-base no Dockerfile.`);
  }
}

export interface HostSessionOpts {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  readonly?: boolean;
  sudo?: boolean;
  env?: Record<string, string>;
}

const READONLY_BLOCK = /\b(rm|rmdir|mv|dd|mkfs|shutdown|reboot|halt|poweroff|kill|pkill|killall|systemctl\s+(stop|restart|disable|kill)|service\s+\S+\s+(stop|restart)|iptables|ufw|truncate|chmod\s+(000|777)|chown|>\s*\/(?!tmp\/|dev\/null))\b/i;

export async function spawnHostShell(opts: HostSessionOpts) {
  const pty = await getPty();
  const hasHostRoot = !!config.hostRoot && existsSync(`${config.hostRoot}/bin/sh`);
  const hostShell = existsSync(`${config.hostRoot}/bin/bash`) ? '/bin/bash' : '/bin/sh';
  const requestedShell = opts.shell && opts.shell !== '/bin/sh' ? opts.shell : hostShell;
  const shell = hasHostRoot ? (process.env.LOGWATCH_CHROOT_BIN || 'chroot') : (opts.sudo ? 'sudo' : requestedShell);
  const args = hasHostRoot
    ? [config.hostRoot, opts.sudo ? '/usr/bin/sudo' : requestedShell, ...(opts.sudo ? ['-i'] : [])]
    : (opts.sudo ? ['-i', '-S', requestedShell] : []);

  const term = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd: hasHostRoot ? '/' : (opts.cwd ?? process.env.HOME ?? '/'),
    env: { ...process.env, TERM: 'xterm-256color', ...(opts.env ?? {}) },
  });

  return {
    onData: (cb: (chunk: string) => void) => term.onData(cb),
    onExit: (cb: (code: number) => void) => term.onExit(({ exitCode }: any) => cb(exitCode)),
    write: (data: string) => {
      if (opts.readonly && READONLY_BLOCK.test(data)) {
        term.write('\r\n\x1b[31m[readonly] comando bloqueado\x1b[0m\r\n');
        return;
      }
      term.write(data);
    },
    resize: (cols: number, rows: number) => term.resize(cols, rows),
    kill: () => term.kill(),
  };
}
