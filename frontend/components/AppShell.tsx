'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Server,
  ScrollText,
  Users,
  LogOut,
  Bell,
  History,
  Database,
  Settings,
  Gauge,
  DollarSign,
  KeyRound,
  Shield,
  Boxes,
  FileCode,
  Download,
  Rocket,
  Terminal as TerminalIcon,
  Database as DbIcon,
  TerminalSquare,
  Radar,
  HeartPulse,
  PhoneCall,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  ChevronRight,
  Search,
  User as UserIcon,
} from 'lucide-react';
import { Auth, apiFetch } from '@/lib/api';
import { loadMyPermissions, hasPerm } from '@/lib/perms';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: any;
  perms?: string[]; // requer ao menos 1 dessas
}

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Observabilidade',
    items: [
      { href: '/', label: 'Visão geral', icon: Activity },
      { href: '/logs', label: 'Logs', icon: ScrollText, perms: ['logs:read'] },
      { href: '/unity', label: 'Logs de chamadas', icon: PhoneCall, perms: ['logs:read'] },
      { href: '/metrics', label: 'Métricas', icon: Gauge, perms: ['metrics:read'] },
      { href: '/alerts', label: 'Alertas', icon: Bell, perms: ['alerts:read'] },
      { href: '/monitor', label: 'Monitoramento', icon: HeartPulse, perms: ['monitor:read'] },
    ],
  },
  {
    title: 'Infraestrutura',
    items: [
      { href: '/servers', label: 'Servidores', icon: Server, perms: ['servers:read'] },
      { href: '/docker', label: 'Docker manager', icon: Boxes, perms: ['docker:control', 'containers:read'] },
      { href: '/scripts', label: 'Scripts', icon: FileCode, perms: ['scripts:read'] },
      { href: '/databases', label: 'PostgreSQL', icon: DbIcon, perms: ['pg:read'] },
      { href: '/patroni', label: 'Cluster Patroni', icon: Database, perms: ['patroni:read'] },
    ],
  },
  {
    title: 'Operações',
    items: [
      { href: '/deploy', label: 'Deploys (CD)', icon: Rocket, perms: ['deploy:read'] },
      { href: '/exports', label: 'Log exports', icon: Download, perms: ['logs:download'] },
      { href: '/audit', label: 'Audit log', icon: History, perms: ['audit:read'] },
    ],
  },
  {
    title: 'Acesso (Zero Trust)',
    items: [
      { href: '/terminal', label: 'Terminal web', icon: TerminalIcon, perms: ['terminal:request', 'terminal:open'] },
      { href: '/db-access', label: 'Acesso a banco', icon: TerminalSquare, perms: ['db:query', 'db:write_request', 'db:write_approve'] },
      { href: '/captures', label: 'Captura de rede/SIP', icon: Radar, perms: ['capture:request', 'capture:approve'] },
    ],
  },
  {
    title: 'Cloud',
    items: [
      { href: '/finops', label: 'FinOps', icon: DollarSign, perms: ['finops:read'] },
      { href: '/credential-rotations', label: 'Rotação de credenciais', icon: KeyRound, perms: ['credrot:read'] },
    ],
  },
  {
    title: 'Conta',
    items: [
      { href: '/settings', label: 'Ajustes / 2FA', icon: Settings },
      { href: '/settings/roles', label: 'Perfis e permissões', icon: Shield, perms: ['roles:read'] },
      { href: '/users', label: 'Usuários', icon: Users, perms: ['users:read'] },
    ],
  },
];

/**
 * Acha o NavItem cujo `href` melhor descreve a rota atual — usado tanto pro
 * label do header quanto (mais importante) pro guard de acesso abaixo.
 * Pega o match MAIS ESPECÍFICO (maior href), pra rotas como
 * "/settings/roles" não caírem no item genérico "/settings".
 */
function matchNavItem(pathname: string): NavItem | null {
  let best: NavItem | null = null;
  for (const g of NAV_GROUPS) {
    for (const i of g.items) {
      const matches = i.href === pathname || (i.href !== '/' && pathname.startsWith(i.href + '/')) || i.href === pathname;
      if (matches && (!best || i.href.length > best.href.length)) {
        best = i;
      }
    }
  }
  return best;
}

function currentPageLabel(pathname: string): string {
  return matchNavItem(pathname)?.label ?? 'SmartGard';
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<ReturnType<typeof Auth.user>>(null);
  const [perms, setPerms] = useState<Set<string> | null>(null);
  const [mfaSetupRequired, setMfaSetupRequired] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // a <nav> da sidebar é recriada do zero a cada navegação (cada page.tsx
  // monta seu próprio <AppShell>, não tem layout persistente no app router
  // ainda) — sem isto, scrollTop sempre volta a 0 ao clicar em qualquer
  // item do menu. sessionStorage (não state) porque precisa sobreviver ao
  // unmount/remount do componente inteiro.
  //
  // Callback ref (não useEffect com deps=[]): o componente retorna `null`
  // enquanto `user` ainda não carregou (ver "if (!user) return null"
  // abaixo), então no PRIMEIRO commit a <nav> nem existe no DOM ainda — um
  // useEffect(.., []) já teria disparado (e saído no `if (!el) return`)
  // antes da <nav> realmente montar, e nunca mais roda de novo. Callback
  // ref dispara exatamente quando o elemento de fato aparece no DOM.
  const navScrollCleanupRef = useRef<() => void>();
  const setNavRef = (el: HTMLElement | null) => {
    navScrollCleanupRef.current?.();
    navScrollCleanupRef.current = undefined;
    if (!el) return;
    const saved = sessionStorage.getItem('lw_sidebar_scroll');
    if (saved) el.scrollTop = parseInt(saved, 10) || 0;
    const onScroll = () => sessionStorage.setItem('lw_sidebar_scroll', String(el.scrollTop));
    el.addEventListener('scroll', onScroll, { passive: true });
    navScrollCleanupRef.current = () => el.removeEventListener('scroll', onScroll);
  };

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem('lw_sidebar_collapsed') : null;
    if (stored === '1') setCollapsed(true);
  }, []);

  useEffect(() => {
    const u = Auth.user();
    if (!u) {
      router.replace('/login');
      return;
    }
    setUser(u);
    setMfaSetupRequired(!!u.mfaSetupRequired);
    loadMyPermissions().then(setPerms);
    apiFetch<{ mfaEnabled: boolean; mfaRequired: boolean; mfaSetupRequired: boolean }>(
      '/auth/me',
    )
      .then((me) => {
        const merged = { ...u, ...me };
        localStorage.setItem('lw_user', JSON.stringify(merged));
        setUser(merged);
        setMfaSetupRequired(!!me.mfaSetupRequired);
      })
      .catch(() => {});
  }, [router]);

  useEffect(() => {
    if (mfaSetupRequired && pathname !== '/settings') {
      router.replace('/settings');
    }
  }, [mfaSetupRequired, pathname, router]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setUserMenuOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  // ⌘K / Ctrl+K abre/fecha o command palette; Esc fecha. Registrado uma vez.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const k = (e.key || '').toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function toggleCollapsed() {
    setCollapsed((c) => {
      localStorage.setItem('lw_sidebar_collapsed', !c ? '1' : '0');
      return !c;
    });
  }

  if (!user) return null;

  return (
    <div className="flex h-screen bg-bg">
      <aside
        className={cn(
          'border-r border-border bg-panel flex flex-col transition-[width] duration-150 shrink-0',
          collapsed ? 'w-[68px]' : 'w-64',
        )}
      >
        <div className={cn('h-14 px-4 border-b border-border flex items-center gap-2.5', collapsed && 'justify-center px-2')}>
          <div className="w-[30px] h-[30px] rounded-[9px] bg-accent-gradient flex items-center justify-center font-extrabold text-[15px] text-white shrink-0 shadow-[0_1px_0_0_rgba(255,255,255,0.25)_inset]">
            S
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <div className="font-bold text-[15px] tracking-tight leading-none">SmartGard</div>
              <div className="text-2xs text-mutedFaint mt-1">Observabilidade</div>
            </div>
          )}
        </div>

        <nav ref={setNavRef} className="flex-1 px-2 py-3 space-y-4 overflow-auto">
          {(() => { const activeHref = matchNavItem(pathname)?.href; return NAV_GROUPS.map((g) => {
            const visible = g.items.filter((i) => {
              if (!i.perms || i.perms.length === 0) return true;
              return hasPerm(perms, ...i.perms);
            });
            if (!visible.length) return null;
            return (
              <div key={g.title}>
                {!collapsed && (
                  <div className="px-2.5 pb-1 text-2xs uppercase tracking-wider text-mutedFaint font-medium">
                    {g.title}
                  </div>
                )}
                <div className="space-y-0.5">
                  {visible.map((n) => {
                    const Icon = n.icon;
                    const active = n.href === activeHref;
                    return (
                      <Link
                        key={n.href}
                        href={n.href}
                        title={collapsed ? n.label : undefined}
                        className={cn(
                          'relative flex items-center gap-2.5 px-2.5 py-[7px] rounded-lg text-sm transition-colors',
                          collapsed && 'justify-center',
                          active
                            ? 'bg-accent/10 text-accentSoft'
                            : 'text-muted hover:text-text hover:bg-panel2',
                        )}
                      >
                        {active && (
                          <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[3px] rounded-full bg-accent" />
                        )}
                        <Icon size={15} className="shrink-0" />
                        {!collapsed && <span className="truncate">{n.label}</span>}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          }); })()}
        </nav>

        <div className="p-2 border-t border-border space-y-1">
          <button
            onClick={toggleCollapsed}
            className={cn(
              'w-full flex items-center gap-2.5 px-2.5 py-[7px] rounded-lg text-sm text-mutedFaint hover:text-text hover:bg-panel2 transition-colors',
              collapsed && 'justify-center',
            )}
          >
            {collapsed ? <ChevronsRight size={15} /> : <ChevronsLeft size={15} />}
            {!collapsed && 'Recolher menu'}
          </button>
          {!collapsed && (
            <div className="px-2.5 pt-1 text-2xs text-mutedFaint/70">
              v{process.env.NEXT_PUBLIC_APP_VERSION ?? '?'}
            </div>
          )}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        {/*
          `relative z-30` aqui é o que faz o menu de usuário (dropdown
          absolute z-50 dentro do header) ficar SEMPRE acima do conteúdo de
          <main>, em qualquer tela. Sem isso, o `backdrop-blur-sm` abaixo cria
          um stacking context próprio pro header — e como esse header não
          tinha z-index explícito, ele e o <main> (irmãos, ambos z-auto)
          competiam só pela ordem no DOM: o <main>, por vir depois, sempre
          pintava por CIMA do header (e do dropdown dentro dele) onde os dois
          se sobrepunham. Em telas com conteúdo logo abaixo do header (ex.:
          barra de busca/resultado dos Logs), isso "comia" visualmente o
          botão "Sair" — daí parecer que ele "se escondia dependendo da
          tela". Dando z-index explícito ao header inteiro, ele passa a
          vencer essa comparação sempre, e o dropdown some por completo de
          baixo de qualquer outro conteúdo da página.
        */}
        <header className="relative z-30 h-14 border-b border-border bg-panel flex items-center gap-4 px-5 shrink-0">
          <div className="text-sm font-medium text-text min-w-[120px]">{currentPageLabel(pathname)}</div>

          <button
            onClick={() => setPaletteOpen(true)}
            className="flex-1 max-w-[440px] mx-auto flex items-center gap-2.5 rounded-[9px] border border-border bg-bg px-3 py-2 text-mutedFaint hover:border-borderStrong transition-colors"
          >
            <Search size={15} />
            <span className="text-[13px]">Buscar telas, servidores, ações…</span>
            <span className="ml-auto font-mono text-[11px] border border-border rounded px-1.5 py-px text-muted">
              ⌘K
            </span>
          </button>

          <div className="flex items-center gap-3 ml-auto">
            {hasPerm(perms, 'alerts:read') && (
              <Link href="/alerts" title="Alertas" className="relative text-muted hover:text-text transition-colors">
                <Bell size={18} />
              </Link>
            )}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setUserMenuOpen((v) => !v)}
              className="flex items-center gap-2 pl-1.5 pr-2.5 py-1.5 rounded-lg hover:bg-panel2 transition-colors"
            >
              <div className="w-6 h-6 rounded-full bg-panel3 border border-border flex items-center justify-center text-muted">
                <UserIcon size={12} />
              </div>
              <span className="text-xs text-muted max-w-[180px] truncate">{user.email}</span>
              <Badge>{user.role}</Badge>
              <ChevronDown size={13} className="text-mutedFaint" />
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 mt-1.5 w-56 rounded-lg border border-border bg-panel shadow-elevate py-1 z-50 animate-fadeIn">
                <div className="px-3 py-2 border-b border-border">
                  <div className="text-sm text-text truncate">{user.email}</div>
                  <div className="text-2xs text-muted">{user.role}</div>
                </div>
                <Link
                  href="/settings"
                  onClick={() => setUserMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-muted hover:text-text hover:bg-panel2"
                >
                  <Settings size={14} /> Ajustes / 2FA
                </Link>
                <button
                  onClick={async () => {
                    await Auth.logout();
                    router.push('/login');
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-danger hover:bg-danger/10"
                >
                  <LogOut size={14} /> Sair
                </button>
              </div>
            )}
          </div>
          </div>
        </header>

        {mfaSetupRequired && (
          <div className="bg-warn/10 border-b border-warn/40 text-warn text-sm px-4 py-2 text-center">
            Sua conta exige autenticação de dois fatores. Configure o 2FA abaixo antes de continuar.
          </div>
        )}

        <main className="flex-1 overflow-auto">
          {(() => {
            // Guard de rota: antes disso, a sidebar só ESCONDIA o link de
            // páginas sem permissão, mas o componente da página em si
            // sempre renderizava por completo pra quem digitasse a URL
            // direto (ex.: /users) — o backend bloqueava só a chamada de
            // API (403 "Missing permission..."), mas o formulário, campos e
            // estrutura da tela inteira ficavam visíveis e "navegáveis"
            // mesmo sem a permissão. Isso é exatamente o que foi reportado:
            // a aplicação "abre a tela" mesmo sem permissão. Esse bloco
            // espelha a mesma lista de perms já usada na sidebar (NAV_GROUPS)
            // pra decidir se renderiza a página ou uma tela de acesso negado
            // — é defesa em profundidade: o backend continua sendo a fonte
            // de verdade (guards em cada endpoint), isso aqui é só a UI
            // parar de expor a tela antes mesmo da chamada falhar.
            const navItem = matchNavItem(pathname);
            const requiredPerms = navItem?.perms;
            if (!requiredPerms || requiredPerms.length === 0) return children;
            if (perms === null) return null; // ainda carregando /me/permissions — evita flash indevido
            if (hasPerm(perms, ...requiredPerms)) return children;
            return <AccessDenied />;
          })()}
        </main>
      </div>

      {paletteOpen && (
        <CommandPalette
          perms={perms}
          onClose={() => setPaletteOpen(false)}
          onNavigate={(href) => {
            setPaletteOpen(false);
            router.push(href);
          }}
        />
      )}
    </div>
  );
}

/**
 * Command palette (⌘K). Reaproveita o NAV_GROUPS já filtrado por permissão —
 * a mesma fonte de verdade da sidebar — pra listar/buscar telas. Setas ↑/↓
 * navegam a lista, Enter abre o item destacado.
 */
function CommandPalette({
  perms,
  onClose,
  onNavigate,
}: {
  perms: Set<string> | null;
  onClose: () => void;
  onNavigate: (href: string) => void;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const all = NAV_GROUPS.flatMap((g) =>
    g.items
      .filter((i) => !i.perms || i.perms.length === 0 || hasPerm(perms, ...i.perms))
      .map((i) => ({ ...i, group: g.title })),
  );
  const query = q.trim().toLowerCase();
  const results = query
    ? all.filter(
        (i) =>
          i.label.toLowerCase().includes(query) ||
          i.group.toLowerCase().includes(query),
      )
    : all;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setActive(0);
  }, [query]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[active];
      if (hit) onNavigate(hit.href);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 pt-[12vh] px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[600px] rounded-xl border border-borderStrong bg-panel shadow-elevate overflow-hidden animate-fadeIn">
        <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-border">
          <Search size={16} className="text-accentSoft shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ir para tela, servidor ou ação…"
            className="flex-1 bg-transparent border-none outline-none text-[15px] text-text placeholder:text-mutedFaint"
          />
          <span className="font-mono text-[10.5px] text-mutedFaint border border-border rounded px-1.5 py-0.5">
            ESC
          </span>
        </div>
        <div className="max-h-[52vh] overflow-auto p-2">
          <div className="px-2.5 py-1.5 text-2xs uppercase tracking-wider text-mutedFaint">
            Navegação
          </div>
          {results.length === 0 ? (
            <div className="py-6 text-center text-sm text-mutedFaint">Nada encontrado.</div>
          ) : (
            results.map((r, idx) => {
              const Icon = r.icon;
              return (
                <button
                  key={r.href}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => onNavigate(r.href)}
                  className={cn(
                    'w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left transition-colors',
                    idx === active ? 'bg-panel3' : 'hover:bg-panel2',
                  )}
                >
                  <span className="w-7 h-7 rounded-lg bg-panel3 border border-border flex items-center justify-center text-accentSoft shrink-0">
                    <Icon size={15} />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-text truncate">{r.label}</span>
                    <span className="block text-xs text-mutedFaint">{r.group}</span>
                  </span>
                  <ChevronRight size={14} className="text-mutedFaint shrink-0" />
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function AccessDenied() {
  return (
    <div className="h-full flex items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <div className="w-10 h-10 rounded-lg bg-danger/10 border border-danger/25 flex items-center justify-center mx-auto mb-3">
          <Shield size={18} className="text-danger" />
        </div>
        <div className="text-sm font-medium text-text mb-1">Acesso negado</div>
        <div className="text-xs text-muted">
          Você não tem permissão para acessar esta página. Se isso for um
          engano, peça a um administrador para revisar seu perfil em
          Perfis e permissões.
        </div>
      </div>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-2xs uppercase tracking-wide text-accentSoft bg-accent/10 border border-accent/25 rounded px-1.5 py-0.5">
      {children}
    </span>
  );
}
