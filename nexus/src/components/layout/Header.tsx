'use client';

import { Fragment, useTransition } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { resolveUserAccess } from '@/lib/auth/permissions';
import { User, Organization, BusinessCentralConnection } from '@/types/database';
import { BusinessCentralConnectionStatusData } from '@/types/businessCentralItems';
import { Search, Bell, ChevronDown, Settings, Shield, LogOut, Check, Menu, AlertCircle, RefreshCw } from 'lucide-react';
import { switchOrganization } from '@/app/actions/organizations';
import { switchBcEnvironment } from '@/app/actions/businessCentralConnections';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

// The selected organization / environment can't be clicked (already chosen), but
// shouldn't look faded: full strength, bold, white in dark mode, black in light.
const SELECTED_ITEM = 'font-bold text-black dark:text-white data-[disabled]:opacity-100';

interface HeaderProps {
  user: User | null;
  organization: Organization | null;
  organizations: Organization[];
  businessCentralStatus: BusinessCentralConnectionStatusData;
  bcConnections: BusinessCentralConnection[];
  activeBcConnectionId: string | null;
  hasBcCredentials: boolean;
  onMenuClick?: () => void;
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export function Header({
  user,
  organization,
  organizations,
  businessCentralStatus,
  bcConnections,
  activeBcConnectionId,
  hasBcCredentials,
  onMenuClick,
}: HeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const access = resolveUserAccess(user);
  const [isSwitchingOrganization, startSwitchOrganization] = useTransition();
  const [isSwitchingEnvironment, startSwitchEnvironment] = useTransition();
  const organizationsToShow = organization && !organizations.some((org) => org.id === organization.id)
    ? [organization, ...organizations]
    : organizations;

  // The active environment falls back to the org default when the user has no
  // explicit selection (or it points at a deleted/cross-org connection) —
  // mirrors resolveActiveBcConnection so the checkmark matches what's in use.
  const defaultBcConnection = bcConnections.find((conn) => conn.is_default) ?? null;
  const effectiveActiveBcConnectionId =
    activeBcConnectionId && bcConnections.some((conn) => conn.id === activeBcConnectionId)
      ? activeBcConnectionId
      : defaultBcConnection?.id ?? null;

  const handleSwitchEnvironment = (connectionId: string) => {
    startSwitchEnvironment(async () => {
      await switchBcEnvironment(connectionId);
      router.refresh();
    });
  };

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  // Generate breadcrumb from pathname
  const getBreadcrumb = () => {
    if (pathname === '/') return 'Dashboard';
    const segment = pathname.split('/').filter(Boolean)[0];
    if (segment === 'admin') return 'Admin Panel';
    return segment.charAt(0).toUpperCase() + segment.slice(1);
  };

  return (
    <header className="bg-surface border-b border-border h-14 flex-shrink-0 flex items-center px-4 justify-between">
      {/* Left side - mobile menu + page title */}
      <div className="flex items-center gap-3">
        {/* Mobile hamburger menu */}
        <button
          onClick={onMenuClick}
          className="size-8 flex items-center justify-center text-foreground-muted hover:text-foreground hover:bg-surface-raised rounded-lg transition-colors lg:hidden"
          aria-label="Toggle sidebar"
        >
          <Menu className="size-5" />
        </button>
        <span className="text-foreground font-medium text-sm">{getBreadcrumb()}</span>
      </div>

      {/* Right side - search, sparkle, org dropdown, user avatar */}
      <div className="flex items-center gap-3">
        {/* Search */}
        <div className="relative hidden sm:flex items-center">
          <Search className="absolute left-3 size-4 text-foreground-subtle" />
          <input
            type="text"
            placeholder="Search..."
            className={cn(
              'w-52 h-9 pl-9 pr-12 rounded-full text-sm',
              'bg-surface border border-border',
              'text-foreground placeholder:text-foreground-subtle',
              'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50',
              'transition-all duration-150'
            )}
          />

        </div>

        {/* Notification bell */}
        <button
          className="size-9 flex items-center justify-center text-foreground-muted hover:text-foreground transition-colors"
        >
          <Bell className="size-5" />
        </button>

        {/* Organization pill */}
        {organization && (
          <DropdownMenu>
            <DropdownMenuTrigger id="app-header-organization-menu-trigger" asChild>
              <button className="flex items-center gap-2 h-8 pl-3.5 pr-3 rounded-full border border-primary/50 bg-primary/10 text-sm hover:bg-primary/20 transition-colors">
                <div className="size-5 rounded bg-primary flex items-center justify-center">
                  <span className="text-[10px] font-bold text-primary-foreground">
                    {organization.name.charAt(0).toUpperCase()}
                  </span>
                </div>
                <span className="text-primary font-medium hidden md:block">{organization.name}</span>
                <ChevronDown className="size-3.5 text-primary/70" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72 p-3">
              <div className="space-y-3">
                <BusinessCentralSyncStatusSection status={businessCentralStatus} />

                <Separator />

                <section className="space-y-1.5">
                  <h3 className="px-1 text-xs font-semibold text-foreground">Organizations</h3>

                  <div className="space-y-1">
                    {organizationsToShow.map((org) => {
                      const isCurrent = org.id === organization.id;
                      return (
                        <Fragment key={org.id}>
                          <DropdownMenuItem
                            disabled={isCurrent || isSwitchingOrganization}
                            onClick={() => {
                              if (!isCurrent) {
                                startSwitchOrganization(() => {
                                  void switchOrganization(org.id);
                                });
                              }
                            }}
                            className={cn('cursor-pointer px-1.5 py-1.5 text-xs', isCurrent && SELECTED_ITEM)}
                          >
                            <div className="size-5 rounded bg-primary/20 flex items-center justify-center">
                              <span className="text-[10px] font-bold text-primary">
                                {org.name.charAt(0).toUpperCase()}
                              </span>
                            </div>
                            <span className="min-w-0 flex-1 truncate">{org.name}</span>
                            {isCurrent && <Check className="size-3.5 text-primary" />}
                          </DropdownMenuItem>

                          {isCurrent && (
                            <div className="space-y-0.5">
                              {!hasBcCredentials ? (
                                <DropdownMenuItem
                                  asChild
                                  className="cursor-pointer px-1.5 py-1.5 text-xs"
                                >
                                  <Link href="/admin">
                                    <span className="ml-7 min-w-0 flex-1 truncate text-foreground-muted">
                                      Configure Business Central
                                    </span>
                                  </Link>
                                </DropdownMenuItem>
                              ) : bcConnections.length === 0 ? (
                                <DropdownMenuItem
                                  asChild
                                  className="cursor-pointer px-1.5 py-1.5 text-xs"
                                >
                                  <Link href="/admin">
                                    <span className="ml-7 min-w-0 flex-1 truncate text-foreground-muted">
                                      No environments
                                    </span>
                                  </Link>
                                </DropdownMenuItem>
                              ) : (
                                bcConnections.map((conn) => {
                                  const isActiveEnv = conn.id === effectiveActiveBcConnectionId;
                                  return (
                                    <DropdownMenuItem
                                      key={conn.id}
                                      disabled={isActiveEnv || isSwitchingEnvironment}
                                      onClick={() => {
                                        if (!isActiveEnv) {
                                          handleSwitchEnvironment(conn.id);
                                        }
                                      }}
                                      className={cn('cursor-pointer px-1.5 py-1.5 text-xs', isActiveEnv && SELECTED_ITEM)}
                                    >
                                      <span className="ml-7 min-w-0 flex-1 truncate">
                                        {conn.display_name}
                                      </span>
                                      {isActiveEnv && <Check className="size-3.5 text-primary" />}
                                    </DropdownMenuItem>
                                  );
                                })
                              )}
                            </div>
                          )}
                        </Fragment>
                      );
                    })}
                  </div>
                </section>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* User avatar */}
        {user && (
          <DropdownMenu>
            <DropdownMenuTrigger id="app-header-user-menu-trigger" asChild>
              <button className="size-9 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center hover:bg-primary/30 transition-colors">
                <span className="text-xs font-bold text-primary">
                  {user.display_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium">{user.display_name}</p>
                  <p className="text-xs text-muted-foreground">{user.email}</p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/settings" className="cursor-pointer">
                  <Settings className="mr-2 size-4" />
                  Settings
                </Link>
              </DropdownMenuItem>
              {access.canManageUsers && (
                <DropdownMenuItem asChild>
                  <Link href="/admin" className="cursor-pointer">
                    <Shield className="mr-2 size-4" />
                    Admin Panel
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleSignOut} variant="destructive" className="cursor-pointer">
                <LogOut className="mr-2 size-4" />
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </header>
  );
}

function BusinessCentralSyncStatusSection({ status }: { status: BusinessCentralConnectionStatusData }) {
  const { connection, syncProgress } = status;

  if (syncProgress.inProgress) {
    return (
      <section className="px-1">
        <h3 className="text-xs font-semibold text-foreground">Business Central sync</h3>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-primary">
          <RefreshCw className="size-3 animate-spin" />
          Syncing since {formatTimestamp(syncProgress.since)}
        </p>
      </section>
    );
  }

  if (connection.kind === 'not_configured') {
    return (
      <section className="px-1">
        <h3 className="text-xs font-semibold text-foreground">Business Central sync</h3>
        <p className="mt-1 text-xs text-foreground-muted">Not connected</p>
      </section>
    );
  }

  if (connection.kind === 'error') {
    return (
      <section className="px-1">
        <h3 className="text-xs font-semibold text-foreground">Business Central sync</h3>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="size-3" />
          Connection error
        </p>
      </section>
    );
  }

  if (connection.lastError) {
    return (
      <section className="px-1">
        <h3 className="text-xs font-semibold text-foreground">Business Central sync</h3>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-warning">
          <AlertCircle className="size-3" />
          Last sync failed
        </p>
      </section>
    );
  }

  return (
    <section className="px-1">
      <h3 className="text-xs font-semibold text-foreground">Business Central sync</h3>
      <p className="mt-1 text-xs text-foreground-muted">
        Last sync: {formatTimestamp(connection.lastPulledAt)}
      </p>
    </section>
  );
}
