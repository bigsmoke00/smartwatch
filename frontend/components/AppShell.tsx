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
} from 'lucide-react';
import { Auth } from '@/lib/api';
import { cn } from '@/lib/utils';

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<ReturnType<typeof Auth.user>>(null);

  useEffect(() => {
    const u = Auth.user();
    if (!u) {
      router.replace('/login');
      return;
    }
    setUser(u);
  }, [router]);

  if (!user) return null;

  const groups: { title: string; items: { href: string; label: string; icon: any; admin?: boolean }[] }[] = [
    {
      title: 'Observabilidade',
      items: [
        { href: '/', label: 'Visão geral', icon: Activity },
        { href: '/logs', label: 'Logs', icon: ScrollText },
        { href: '/metrics', label: 'Métricas', icon: Gauge },
        { href: '/alerts', label: 'Alertas', icon: Bell },
      ],
    },
    {
      title: 'Infraestrutura',
      items: [
        { href: '/servers', label: 'Servidores', icon: Server },
        { href: '/containers', label: 'Containers', icon: Container },
        { href: '/inventory', label: 'Inventário cloud', icon: CloudCog },
        { href: '/patroni', label: 'Cluster Patroni', icon: Database },
      ],
    },
    {
      title: 'Operações',
      items: [
        { href: '/automation', label: 'Automação', icon: PlayCircle },
        { href: '/audit', label: 'Audit log', icon: History, admin: true },
      ],
    },
    {
      title: 'Conta',
      items: [
        { href: '/settings', label: 'Ajustes / 2FA', icon: Settings },
        { href: '/users', label: 'Usuários', icon: Users, admin: true },
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
          <div className="text-xs text-muted mt-1 truncate">{user.email} <span className="text-accent">({user.role})</span></div>
        </div>
        <nav className="flex-1 p-2 space-y-3 overflow-auto">
          {groups.map((g) => {
            const visible = g.items.filter((i) => !i.admin || user.role === 'admin');
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
