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
 * SEGURANÇA — usuário do SO e sudo:
 * O backend já resolveu, ANTES de chamar aqui, qual `targetUser` a pessoa
 * deve usar (mapeamento `user_server_logins`, ou fallback do email) e se
 * `sudo` foi de fato concedido (não é mais "o que o checkbox do form
 * mandou" — ver terminal.gateway.ts). O agent normalmente roda como root
 * (precisa pra ler /var/log, falar com o docker.sock, montar /host, etc.),
 * então usamos esse root pra fazer `su - <targetUser>` SEM precisar da
 * senha da pessoa — exatamente como um bastion de verdade faria. Isso é o
 * que garante "no modo readonly a pessoa entra pelo usuário dela" em vez
 * de sempre cair como root.
 *
 * Modo readonly: além de rodar como um usuário sem sudo (na prática, sem
 * privilégio de escrita se o SO estiver configurado corretamente), ainda
 * aplicamos um bloqueio client-side de comandos obviamente destrutivos
 * como defesa em profundidade — não é uma sandbox real, é só uma rede de
 * segurança extra enquanto o isolamento de verdade depende da permissão
 * do `targetUser` no SO.
 *
 * Captura de comandos: setamos HISTFILE/HISTTIMEFORMAT/PROMPT_COMMAND num
 * arquivo exclusivo da sessão, e o agent faz polling desse arquivo,
 * emitindo cada comando via `onCommand` pro backend gravar em
 * terminal_session_commands — isso alimenta o "arquivo de fácil
 * visualização" do que a pessoa executou, sem precisar decodificar o
 * dump bruto de I/O (que tem códigos ANSI, telas de editor, etc.)
 */
import { config } from './config.js';
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';

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
  sessionId: string;
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  readonly?: boolean;
  /** Já validado pelo backend (mapeamento user_server_logins) — não é mais "o que o form mandou". */
  sudo?: boolean;
  /** Usuário do SO resolvido pelo backend. Se ausente, cai no comportamento legado (roda como o próprio agent). */
  targetUser?: string;
  env?: Record<string, string>;
}

const READONLY_BLOCK = /\b(rm|rmdir|mv|dd|mkfs|shutdown|reboot|halt|poweroff|kill|pkill|killall|systemctl\s+(stop|restart|disable|kill)|service\s+\S+\s+(stop|restart)|iptables|ufw|truncate|chmod\s+(000|777)|chown|>\s*\/(?!tmp\/|dev\/null))\b/i;

function shellQuoteUser(u: string): boolean {
  // Validação redundante à do backend — nunca confiamos só na outra ponta.
  // OBS: ponto é permitido (ex: geraldo.cruz) — é um padrão comum de login
  // name. A regex antiga sem "." rejeitava esse caso, caindo no modo legado
  // (sem targetUser => roda como o próprio agent, ou seja, root).
  return /^[a-z_][a-z0-9._-]{0,31}$/.test(u);
}

export async function spawnHostShell(opts: HostSessionOpts) {
  const pty = await getPty();
  const hasHostRoot = !!config.hostRoot && existsSync(`${config.hostRoot}/bin/sh`);
  const hostShell = existsSync(`${config.hostRoot}/bin/bash`) ? '/bin/bash' : '/bin/sh';
  const requestedShell = opts.shell && opts.shell !== '/bin/sh' ? opts.shell : hostShell;

  const histFile = `/tmp/.logwatch_hist_${opts.sessionId.replace(/[^a-zA-Z0-9-]/g, '')}`;
  await writeFile(histFile, '').catch(() => {});

  const targetUser = opts.targetUser && shellQuoteUser(opts.targetUser) ? opts.targetUser : undefined;
  if (opts.targetUser && !targetUser) {
    console.warn(`[host-shell] targetUser "${opts.targetUser}" rejeitado por validação, caindo no usuário do agent`);
  }

  let shell: string;
  let args: string[];

  if (targetUser) {
    // Comandos de ambiente vão dentro da string -c (são parseados pelo
    // shell da pessoa via `su -c`), não pelo env do node-pty — assim
    // sobrevivem mesmo que `su -` zere o ambiente herdado.
    const envPrefix = `HISTFILE=${histFile} HISTSIZE=10000 HISTFILESIZE=10000 ` +
      `HISTTIMEFORMAT='%s ' HISTCONTROL= PROMPT_COMMAND='history -a'`;
    const innerCmd = opts.sudo
      ? `${envPrefix} exec sudo -E -i`
      : `${envPrefix} exec ${requestedShell} -i`;
    const suArgs = ['-', targetUser, '-c', innerCmd];
    if (hasHostRoot) {
      shell = process.env.LOGWATCH_CHROOT_BIN || 'chroot';
      args = [config.hostRoot, 'su', ...suArgs];
    } else {
      shell = 'su';
      args = suArgs;
    }
  } else {
    // Legado: sem targetUser resolvido, roda como o próprio agent (igual
    // ao comportamento de antes desta correção).
    shell = hasHostRoot ? (process.env.LOGWATCH_CHROOT_BIN || 'chroot') : (opts.sudo ? 'sudo' : requestedShell);
    args = hasHostRoot
      ? [config.hostRoot, opts.sudo ? '/usr/bin/sudo' : requestedShell, ...(opts.sudo ? ['-i'] : [])]
      : (opts.sudo ? ['-i', '-S', requestedShell] : []);
  }

  const term = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd: hasHostRoot ? '/' : (opts.cwd ?? process.env.HOME ?? '/'),
    env: { ...process.env, TERM: 'xterm-256color', ...(opts.env ?? {}) },
  });

  // ---- captura de comandos (polling no HISTFILE) ----
  let lastOffset = 0;
  let pending: string | null = null; // linha "#<epoch>" aguardando o comando da próxima linha
  let commandCb: ((cmd: string, ts?: string) => void) | null = null;
  const pollTimer = setInterval(async () => {
    try {
      const content = await readFile(histFile, 'utf-8').catch(() => '');
      if (content.length <= lastOffset) return;
      const chunk = content.slice(lastOffset);
      lastOffset = content.length;
      for (const line of chunk.split('\n')) {
        if (!line) continue;
        if (line.startsWith('#')) {
          const epoch = line.slice(1).trim();
          pending = /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000).toISOString() : null;
          continue;
        }
        commandCb?.(line, pending ?? undefined);
        pending = null;
      }
    } catch { /* ignore */ }
  }, 700);

  const cleanup = () => {
    clearInterval(pollTimer);
    unlink(histFile).catch(() => {});
  };

  // ---- bloqueio readonly: precisa olhar a LINHA inteira, não tecla a tecla.
  // O xterm.js manda cada tecla num write() separado, então testar
  // READONLY_BLOCK contra um único caractere nunca casava com nada — esse
  // era o motivo do "modo readonly não funciona" mesmo antes do bug do
  // usuário do SO. Acumulamos os caracteres da linha atual e só decidimos
  // ao ver Enter, antes de repassar pro pty (em modo canônico o shell só
  // recebe/processa a linha quando o \n chega, então dá pra interceptar a
  // tempo). Backspace/Ctrl também são tratados pra manter o buffer em sync.
  let lineBuf = '';
  let dataCb: ((chunk: string) => void) | null = null;

  return {
    onData: (cb: (chunk: string) => void) => { dataCb = cb; return term.onData(cb); },
    onExit: (cb: (code: number) => void) => term.onExit(({ exitCode }: any) => { cleanup(); cb(exitCode); }),
    onCommand: (cb: (cmd: string, ts?: string) => void) => { commandCb = cb; },
    write: (data: string) => {
      if (!opts.readonly) { term.write(data); return; }

      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          const line = lineBuf;
          lineBuf = '';
          if (line.trim() && READONLY_BLOCK.test(line)) {
            // Ctrl+U limpa a linha já digitada no buffer canônico do tty
            // (apaga o que o shell ainda não processou), sem deixar o \n
            // passar — o comando nunca chega a ser executado.
            term.write('\x15');
            dataCb?.(`\r\n\x1b[31m[readonly] comando bloqueado: ${line.trim()}\x1b[0m\r\n`);
          } else {
            // a linha em si já foi repassada char a char acima — só falta
            // o terminador (\r/\n) pra mandar o shell processar.
            term.write(ch);
          }
        } else if (ch === '\x7f' || ch === '\b') {
          lineBuf = lineBuf.slice(0, -1);
          term.write(ch);
        } else if (ch === '\x15') { // Ctrl+U digitado pela própria pessoa
          lineBuf = '';
          term.write(ch);
        } else if (ch === '\x03') { // Ctrl+C
          lineBuf = '';
          term.write(ch);
        } else if (ch >= ' ' || ch === '\t') {
          lineBuf += ch;
          term.write(ch);
        } else {
          // outros controles (setas, etc.) — repassa sem tocar no buffer
          term.write(ch);
        }
      }
    },
    resize: (cols: number, rows: number) => term.resize(cols, rows),
    kill: () => { cleanup(); term.kill(); },
  };
}
