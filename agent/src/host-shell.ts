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
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { executeScript } from './fs-ops.js';

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

// OBS sobre os limites desse bloqueio: isso é um BLACKLIST de padrões na
// linha digitada — funciona pra comandos shell de uma linha (rm, mv, dd,
// redirecionamentos), mas NÃO impede escrita feita de dentro de um programa
// full-screen interativo (nano/vim/etc.) depois que ele abre — uma vez
// dentro do editor, as teclas não formam mais "uma linha de comando" pro
// shell, então o regex nunca mais vê nada pra bloquear. Por isso agora
// bloqueamos a ABERTURA desses editores/ferramentas de escrita direta
// também (nano, vim, emacs, tee, sed -i, ...), e cobrimos ">>" além de ">"
// no redirecionamento (antes só ">" sozinho escapava de "echo x >> /etc/...").
// Mesmo assim isto continua sendo "rede de segurança" client-side, não uma
// sandbox real — a garantia de verdade tem que vir da permissão do usuário
// do SO (targetUser) no host, que é o que realmente impede escrita.
const READONLY_BLOCK = /\b(rm|rmdir|mv|dd|mkfs|shutdown|reboot|halt|poweroff|kill|pkill|killall|systemctl\s+(stop|restart|disable|kill)|service\s+\S+\s+(stop|restart)|iptables|ufw|truncate|chmod\s+(000|777)|chown|nano|vim|nvim|vi|emacs|pico|joe|ed|tee|sed\s+-i|>>?\s*\/(?!tmp\/|dev\/null))\b/i;

function shellQuoteUser(u: string): boolean {
  // Validação redundante à do backend — nunca confiamos só na outra ponta.
  // OBS: ponto é permitido (ex: geraldo.cruz) — é um padrão comum de login
  // name. A regex antiga sem "." rejeitava esse caso, caindo no modo legado
  // (sem targetUser => roda como o próprio agent, ou seja, root).
  return /^[a-z_][a-z0-9._-]{0,31}$/.test(u);
}

function shQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

function sudoersVirtualPath(sessionId: string): string {
  // Um drop-in por sessão (nome inclui o sessionId) — assim sessões
  // concorrentes não colidem/sobrescrevem o NOPASSWD umas das outras, e
  // revogar uma não afeta as demais ainda ativas.
  return `/etc/sudoers.d/zerotrust-${sessionId.replace(/[^a-zA-Z0-9-]/g, '')}`;
}

/**
 * Concede sudo SEM SENHA ao targetUser, só pela duração da sessão — via
 * drop-in em /etc/sudoers.d (nunca editando o /etc/sudoers principal).
 * Valida com `visudo -cf` ANTES de ativar o arquivo (rename atômico): se a
 * sintaxe estiver errada, o arquivo nunca chega a ser lido pelo sudo, então
 * um bug aqui não pode "quebrar o sudo" do servidor inteiro.
 * Pré-requisito de infra: o usuário já precisa existir no SO (mapeamento
 * `user_server_logins`, resolvido antes de chegar aqui) — isso aqui só dá o
 * NOPASSWD, não cria conta nem adiciona a nenhum grupo.
 */
async function grantSudoNopasswd(targetUser: string, sessionId: string, hasHostRoot: boolean): Promise<boolean> {
  const virtualPath = sudoersVirtualPath(sessionId);
  const tmpVirtual = `${virtualPath}.tmp`;
  const realPath = hasHostRoot ? `${config.hostRoot}${virtualPath}` : virtualPath;
  const tmpReal = hasHostRoot ? `${config.hostRoot}${tmpVirtual}` : tmpVirtual;
  const body = `# logwatch zero-trust — temporario (sessao ${sessionId}), removido ao encerrar\n` +
    `${targetUser} ALL=(ALL) NOPASSWD: ALL\n`;
  try {
    await writeFile(tmpReal, body, { mode: 0o440 });
    const check = await executeScript({
      path: '/bin/sh',
      args: ['-lc', `visudo -cf ${shQuote(tmpVirtual)}`],
      timeoutMs: 5000,
    });
    if (check.exitCode !== 0) {
      await unlink(tmpReal).catch(() => {});
      console.warn(`[host-shell] visudo rejeitou sudoers temporario p/ sessao ${sessionId}: ${(check.stderr || check.stdout).trim()}`);
      return false;
    }
    await rename(tmpReal, realPath);
    await chmod(realPath, 0o440);
    return true;
  } catch (e: any) {
    console.warn(`[host-shell] falha ao conceder sudo NOPASSWD (sessao ${sessionId}): ${e.message}`);
    await unlink(tmpReal).catch(() => {});
    return false;
  }
}

/** Remove o drop-in da sessão — a pessoa perde o NOPASSWD assim que a sessão fecha/expira. */
async function revokeSudoNopasswd(sessionId: string, hasHostRoot: boolean): Promise<void> {
  const virtualPath = sudoersVirtualPath(sessionId);
  const realPath = hasHostRoot ? `${config.hostRoot}${virtualPath}` : virtualPath;
  await unlink(realPath).catch(() => {});
}

export async function spawnHostShell(opts: HostSessionOpts) {
  const pty = await getPty();
  const hasHostRoot = !!config.hostRoot && existsSync(`${config.hostRoot}/bin/sh`);
  const hostShell = existsSync(`${config.hostRoot}/bin/bash`) ? '/bin/bash' : '/bin/sh';
  const requestedShell = opts.shell && opts.shell !== '/bin/sh' ? opts.shell : hostShell;

  // Caminho que o PRÓPRIO shell vai usar via HISTFILE — sempre relativo à
  // raiz que ELE vê. Quando há chroot (hasHostRoot), o shell roda com root
  // = config.hostRoot, então "/tmp/..." pra ele é "${config.hostRoot}/tmp/..."
  // no disco real. O agent (que não está chrootado) precisa ler/escrever
  // esse MESMO arquivo usando o caminho completo (com o prefixo) — senão
  // fica lendo um /tmp/... que é o /tmp do próprio container do agent, um
  // arquivo totalmente diferente, e a captura de comando nunca vê nada
  // (era exatamente esse o bug: zero trust e logs funcionam pq não dependem
  // desse arquivo, só a captura de comando/transcript dependia).
  const histFileInShell = `/tmp/.logwatch_hist_${opts.sessionId.replace(/[^a-zA-Z0-9-]/g, '')}`;
  const histFile = hasHostRoot ? `${config.hostRoot}${histFileInShell}` : histFileInShell;
  await writeFile(histFile, '').catch(() => {});

  const targetUser = opts.targetUser && shellQuoteUser(opts.targetUser) ? opts.targetUser : undefined;
  if (opts.targetUser && !targetUser) {
    console.warn(`[host-shell] targetUser "${opts.targetUser}" rejeitado por validação, caindo no usuário do agent`);
  }

  // Concede NOPASSWD temporário ANTES de montar o comando — se a pessoa tem
  // sudo aprovado pra essa sessão, ela não deve precisar digitar senha
  // alguma (a aprovação zero-trust JÁ é a autenticação). Se a concessão
  // falhar (visudo rejeitou, sem permissão de escrita em /etc/sudoers.d,
  // etc.), seguimos sem travar a sessão — só fica sem o NOPASSWD, e o sudo
  // vai pedir senha normalmente (ou falhar, se o usuário não tiver senha
  // configurada — comportamento prévio, não uma regressão).
  let sudoGranted = false;
  if (opts.sudo && targetUser) {
    sudoGranted = await grantSudoNopasswd(targetUser, opts.sessionId, hasHostRoot);
    if (!sudoGranted) {
      console.warn(`[host-shell] sessao ${opts.sessionId}: seguindo sem NOPASSWD (sudo pode pedir senha)`);
    }
  }

  let shell: string;
  let args: string[];

  if (targetUser) {
    // Comandos de ambiente vão dentro da string -c (são parseados pelo
    // shell da pessoa via `su -c`), não pelo env do node-pty — assim
    // sobrevivem mesmo que `su -` zere o ambiente herdado.
    const envPrefix = `HISTFILE=${histFileInShell} HISTSIZE=10000 HISTFILESIZE=10000 ` +
      `HISTTIMEFORMAT='%s ' HISTCONTROL= PROMPT_COMMAND='history -a'`;
    // sudo -i e sudo -E são mutuamente exclusivos (-i simula login e RESETA
    // o ambiente; -E preserva o ambiente do chamador — daí o erro "você não
    // pode especificar as opções -i e -E ao mesmo tempo", que fazia o `su -c`
    // falhar de cara (exit 1) sem nunca abrir um shell de verdade — e é por
    // isso que nenhum comando era capturado: a sessão morria antes de
    // escrever qualquer coisa no HISTFILE. Em vez do -i do sudo (que tenta
    // "logar" como root e por isso zera o ambiente), passamos -E pro sudo e
    // pedimos o -i pro SHELL de destino (mesmo padrão do branch sem sudo
    // abaixo) — preserva HISTFILE/HISTSIZE/etc. e ainda fica interativo.
    const innerCmd = opts.sudo
      ? `${envPrefix} exec sudo -E ${requestedShell} -i`
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
    // Perde o NOPASSWD assim que a sessão acaba (exit, fechamento manual,
    // TTL/idle pelo cron do backend) — privilégio elevado nunca fica
    // "esquecido" ligado depois que a aprovação zero-trust expira.
    if (sudoGranted) revokeSudoNopasswd(opts.sessionId, hasHostRoot).catch(() => {});
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
