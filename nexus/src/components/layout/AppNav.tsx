'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  canAccessArtworkWorkspace,
  canViewCustomers,
  canViewReceivables,
  resolveUserAccess,
} from '@/lib/auth/permissions';
import { cn } from '@/lib/utils';
import { User } from '@/types/database';
import {
  LayoutGrid,
  BarChart3,
  ShoppingCart,
  Palette,
  FileText,
  Truck,
  Settings,
  HelpCircle,
  Menu,
  Package,
  HeartHandshake,
  Users,
  Clock,
  ListChecks,
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';

type NavItem = {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string | number;
};

type NavGroup = {
  title?: string;
  items: NavItem[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutGrid },
      { label: 'Analytics', href: '/analytics', icon: BarChart3 },
    ],
  },
  {
    title: 'Catalog',
    items: [{ label: 'Items', href: '/items', icon: Package }],
  },
  {
    title: 'Purchase Orders',
    items: [
      { label: 'Orders', href: '/orders', icon: ShoppingCart },
      { label: 'Artwork', href: '/artwork', icon: Palette },
      { label: 'Purchase invoices', href: '/invoices', icon: FileText },
      { label: 'Shipments', href: '/shipments', icon: Truck },
    ],
  },
  {
    title: 'Receivables',
    items: [
      { label: 'Customers', href: '/customers', icon: Users },
      { label: 'Customer lists', href: '/customer-lists', icon: ListChecks },
      { label: 'Receivables', href: '/receivables', icon: Clock },
      { label: 'Sales invoices', href: '/receivables/invoices', icon: FileText },
    ],
  },
  {
    title: 'Internal Sales',
    items: [
      { label: 'Friends & Family', href: '/fnforders', icon: HeartHandshake },
    ],
  },
  {
    title: 'System',
    items: [
      { label: 'Settings', href: '/settings', icon: Settings },
      { label: 'Help', href: '/help', icon: HelpCircle },
    ],
  },
];

interface AppNavProps {
  user?: User | null;
  collapsed?: boolean;
  onCollapse?: (collapsed: boolean) => void;
  onMenuClick?: () => void;
  onNavigateStart?: (href: string) => void;
}

export function AppNav({
  user = null,
  collapsed = false,
  onCollapse,
  onMenuClick,
  onNavigateStart,
}: AppNavProps) {
  const pathname = usePathname();
  const access = resolveUserAccess(user);
  const isCollapsed = onCollapse ? collapsed : false;
  const navGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (item.href === '/artwork') {
        return canAccessArtworkWorkspace(access);
      }
      if (item.href === '/invoices') {
        return access.canViewInvoices;
      }
      if (item.href === '/customers') {
        return canViewCustomers(access);
      }
      if (item.href === '/receivables' || item.href === '/receivables/invoices') {
        return canViewReceivables(access);
      }

      return true;
    }),
  })).filter((group) => group.items.length > 0);

  // Highlight only the most specific match, so /receivables/invoices doesn't also light up /receivables.
  const activeHref = navGroups
    .flatMap((group) => group.items.map((item) => item.href))
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <>
      {/* Mobile overlay backdrop */}
      <div
        className={cn(
          'fixed inset-0 bg-black/50 z-30 lg:hidden transition-opacity duration-300 ease-in-out',
          isCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'
        )}
        onClick={onMenuClick}
      />
      <aside
        className={cn(
          'flex flex-col h-full transition-all duration-300 ease-in-out',
          'bg-sidebar border-r border-sidebar-border',
          'shrink-0',
          // Mobile: fixed overlay, hidden when collapsed
          'max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-40',
          isCollapsed ? 'max-lg:-translate-x-full w-16' : 'max-lg:translate-x-0 w-[200px]'
        )}
      >
      {/* Hamburger Menu */}
      <div className="flex items-center px-4 py-4 border-b border-sidebar-border shrink-0">
        <button
          onClick={onMenuClick}
          className="size-8 shrink-0 flex items-center justify-center text-foreground-muted hover:text-foreground hover:bg-surface-raised rounded-lg transition-colors"
          aria-label="Toggle sidebar"
        >
          <Menu className="size-5" />
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-3 px-2 space-y-4">
        {navGroups.map((group, gi) => (
          <div key={gi}>
            {group.title && (
              <div className="h-6 flex items-center px-2 mb-1 relative">
                <p className={cn(
                  'text-[10px] font-semibold uppercase tracking-widest text-foreground-subtle whitespace-nowrap transition-opacity duration-150',
                  isCollapsed ? 'opacity-0' : 'opacity-100 delay-150'
                )}>
                  {group.title}
                </p>
                <div className={cn(
                  'absolute inset-x-2 top-1/2 -translate-y-1/2 border-t border-border transition-opacity duration-150',
                  isCollapsed ? 'opacity-100 delay-150' : 'opacity-0'
                )} />
              </div>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const isActive = item.href === activeHref;
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      title={isCollapsed ? item.label : undefined}
                      onClick={() => onNavigateStart?.(item.href)}
                      className={cn(
                        'w-full flex items-center py-2 px-3.5 rounded-xl text-sm group relative',
                        isActive
                          ? 'bg-primary-subtle text-primary font-medium blue-glow-sm'
                          : 'text-foreground-muted hover:text-foreground hover:bg-surface-raised'
                      )}
                    >
                      <span className={cn(
                        'shrink-0 transition-colors',
                        isActive ? 'text-primary' : 'text-foreground-subtle group-hover:text-foreground-muted'
                      )}>
                        <Icon className="w-4 h-4" />
                      </span>
                      <span className={cn(
                        'flex-1 text-left leading-none whitespace-nowrap overflow-hidden transition-[opacity,margin] duration-150',
                        isCollapsed ? 'opacity-0 ml-0 w-0' : 'opacity-100 ml-2.5 delay-150'
                      )}>
                        {item.label}
                      </span>
                      <span className={cn(
                        'overflow-hidden transition-[opacity,width] duration-150',
                        isCollapsed ? 'opacity-0 w-0' : 'opacity-100 delay-150',
                        item.badge === undefined && 'hidden'
                      )}>
                        <span className={cn(
                          'text-[10px] font-semibold px-1.5 py-0.5 rounded-full leading-none whitespace-nowrap',
                          typeof item.badge === 'number'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-warning-subtle text-warning'
                        )}>
                          {item.badge}
                        </span>
                      </span>
                      {item.badge !== undefined && (
                        <span className={cn(
                          'absolute top-1 right-1 w-2 h-2 rounded-full bg-primary transition-opacity duration-150',
                          isCollapsed ? 'opacity-100 delay-150' : 'opacity-0'
                        )} />
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Theme toggle */}
      <div className="border-t border-sidebar-border p-2 shrink-0">
        <ThemeToggle collapsed={isCollapsed} />
      </div>

      {/* Logo */}
      <div className="border-t border-sidebar-border p-2 shrink-0">
        <div className="flex items-center px-2 py-2">
          <div className="w-8 h-8 rounded-xl bg-primary flex items-center justify-center shrink-0 blue-glow-sm">
            <svg viewBox="0 0 20 20" fill="none" className="w-4 h-4 text-primary-foreground">
              <path d="M10 2L17 6V14L10 18L3 14V6L10 2Z" fill="currentColor" opacity="0.9" />
              <path d="M10 7L14 9.5V14.5L10 17L6 14.5V9.5L10 7Z" fill="white" opacity="0.4" />
            </svg>
          </div>
          <div className={cn(
            'whitespace-nowrap overflow-hidden transition-[opacity,margin,width] duration-150',
            isCollapsed ? 'opacity-0 ml-0 w-0' : 'opacity-100 ml-2.5 delay-150'
          )}>
            <p className="text-sm font-semibold text-foreground leading-none">Nexus</p>
            <p className="text-[10px] text-foreground-muted mt-0.5 leading-none">Enterprise Suite</p>
          </div>
        </div>
      </div>
    </aside>
    </>
  );
}
