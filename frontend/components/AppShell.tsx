'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Server,
  ScrollText,
  Users,
  LogOut,
  Activity,
  Bell,
  PlayCircle,
  CloudCog,
  History,
  Database,
  Settings,
  Container,
  Gauge,
  DollarSign,
  GitBranch,
  KeyRound,
  Target,
  GitPullRequestArrow,
  Shield,
  Boxes,
} from 'lucide-react';
import { Auth } from '@/lib/api';
import { loadMyPermissions, hasPerm } from '@/lib/perms';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: any;
  perms?: string[]; // requer ao menos 1 dessas
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<ReturnType<typeof Auth.user>>(null);
  const [perms, setPerms] = useState<Set<string> | null>(null);

  useEffect(() => {
    const u = Auth.user();
    if (!u) {
      router.replace('/login');
      return;
    }
    setUser(u);
    loadMyPermissions().then(setPerms);
  }, [router]);

  if (!user) return null;

  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: 'Observabilidade',
      items: [
        { href: '/', label: 'Visão geral', icon: Activity },
        { href: '/logs', label: 'Logs', icon: ScrollText, perms: ['logs:read'] },
        { href: '/metrics', label: 'Métricas', icon: Gauge, perms: ['metrics:read'] },
        { href: '/alerts', label: 'Alertas', icon: Bell, perms: ['alerts:read'] },
      ],
    },
    {
      title: 'Infraestrutura',
      items: [
        { href: '/servers', label: 'Servidores', icon: Server, perms: ['servers:read'] },
        { href: '/containers', label: 'Containers', icon: Container, perms: ['containers:read'] },
        { href: '/docker', label: 'Docker manager', icon: Boxes, perms: ['docker:control', 'containers:read'] },
        { href: '/inventory', label: 'Inventário cloud', icon: CloudCog, perms: ['inventory:cloud_sync'] },
        { href: '/patroni', label: 'Cluster Patroni', icon: Database, perms: ['patroni:read'] },
      ],
    },
    {
      title: 'Operações',
      items: [
        { href: '/automation', label: 'Automação', icon: PlayCircle, perms: ['automation:read', 'automation:run'] },
        { href: '/terraform', label: 'Terraform CP', icon: GitBranch, perms: ['terraform:read'] },
        { href: '/pipelines', label: 'Pipelines (GH Actions)', icon: GitPullRequestArrow, perms: ['pipelines:read'] },
        { href: '/audit', label: 'Audit log', icon: History, perms: ['audit:read'] },
      ],
    },
    {
      title: 'Cloud',
      items: [
        { href: '/finops', label: 'FinOps', icon: DollarSign, perms: ['finops:read'] },
        { href: '/slo', label: 'SLO / Error budget', icon: Target, perms: ['slo:read'] },
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

  return (
    <div className="flex h-screen">
      <aside className="w-64 border-r border-border bg-panel flex flex-col">
        <div className="px-4 py-4 border-b border-border">
          <div className="font-semibold text-lg flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-accent" />
            LogWatch
          </div>
          <div className="text-xs text-muted mt-1 truncate">
            {user.email} <span className="text-accent">({user.role})</span>
          </div>
        </div>
        <nav className="flex-1 p-2 space-y-3 overflow-auto">
          {groups.map((g) => {
            const visible = g.items.filter((i) => {
              if (!i.perms || i.perms.length === 0) return true;
              return hasPerm(perms, ...i.perms);
            });
            if (!visible.length) return null;
            return (
              <div key={g.title}>
                <div className="px-3 pb-1 text-[10px] uppercase tracking-wider text-muted">{g.title}</div>
                <div className="space-y-0.5">
                  {visible.map((n) => {
                    const Icon = n.icon;
                    const active =
                      pathname === n.href ||
                      (n.href !== '/' && pathname.startsWith(n.href));
                    return (
                      <Link
                        key={n.href}
                        href={n.href}
                        className={cn(
                          'flex items-center gap-2 px-3 py-1.5 rounded-md text-sm hover:bg-panel2',
                          active && 'bg-panel2 text-accent',
                        )}
                      >
                        <Icon size={15} />
                        {n.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>
        <button
          onClick={async () => {
            await Auth.logout();
            router.push('/login');
          }}
          className="m-2 flex items-center gap-2 px-3 py-2 rounded-md text-sm hover:bg-panel2 text-muted"
        >
          <LogOut size={16} /> Sair
        </button>
      </aside>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
