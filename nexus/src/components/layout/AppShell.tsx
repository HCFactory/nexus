'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AppNav } from './AppNav';
import { Header } from './Header';
import { createClient } from '@/lib/supabase/client';
import { User, Organization, BusinessCentralConnection } from '@/types/database';
import { BusinessCentralConnectionStatusData } from '@/types/businessCentralItems';

interface AppShellProps {
  user: User | null;
  organization: Organization | null;
  organizations: Organization[];
  businessCentralStatus: BusinessCentralConnectionStatusData;
  bcConnections: BusinessCentralConnection[];
  activeBcConnectionId: string | null;
  hasBcCredentials: boolean;
  children: React.ReactNode;
}

function buildPermissionsFingerprint(
  user:
    | Partial<Pick<User, 'organization_id' | 'role' | 'permissions_version' | 'permissions_updated_at' | 'active_bc_connection_id'>>
    | null
    | undefined
) {
  if (!user) {
    return null;
  }

  return JSON.stringify({
    organization_id: user.organization_id ?? null,
    role: user.role ?? null,
    permissions_version: user.permissions_version ?? null,
    permissions_updated_at: user.permissions_updated_at ?? null,
    active_bc_connection_id: user.active_bc_connection_id ?? null,
  });
}

export function AppShell({ user, organization, organizations, businessCentralStatus, bcConnections, activeBcConnectionId, hasBcCredentials, children }: AppShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const router = useRouter();
  const pathname = usePathname();
  const pendingNavigationPathRef = useRef<string | null>(null);
  const queuedPermissionRefreshRef = useRef(false);
  const refreshFingerprint = useMemo(() => buildPermissionsFingerprint(user), [user]);

  const handleToggleSidebar = () => {
    setSidebarCollapsed((prev) => !prev);
  };

  const handleNavigationStart = useCallback(
    (href: string) => {
      if (window.matchMedia('(max-width: 1023px)').matches) {
        setSidebarCollapsed(true);
      }

      if (href === pathname) {
        pendingNavigationPathRef.current = null;
        return;
      }

      pendingNavigationPathRef.current = href;
    },
    [pathname]
  );

  useEffect(() => {
    if (pendingNavigationPathRef.current !== pathname) {
      return;
    }

    pendingNavigationPathRef.current = null;

    if (queuedPermissionRefreshRef.current) {
      queuedPermissionRefreshRef.current = false;
      router.refresh();
    }
  }, [pathname, router]);

  useEffect(() => {
    if (!user) {
      return;
    }

    const supabase = createClient();
    let lastFingerprint = refreshFingerprint;
    let cancelled = false;

    const refreshForPermissionChange = (nextFingerprint: string) => {
      if (nextFingerprint === lastFingerprint) {
        return;
      }

      lastFingerprint = nextFingerprint;

      if (pendingNavigationPathRef.current && pendingNavigationPathRef.current !== pathname) {
        queuedPermissionRefreshRef.current = true;
        return;
      }

      router.refresh();
    };

    const checkCurrentUserFingerprint = async () => {
      if (cancelled) {
        return;
      }

      const { data, error } = await supabase
        .from('users')
        .select('organization_id, role, permissions_version, permissions_updated_at, active_bc_connection_id')
        .eq('id', user.id)
        .single();

      if (cancelled || error || !data) {
        return;
      }

      const nextFingerprint = buildPermissionsFingerprint(data);

      if (!nextFingerprint) {
        return;
      }

      refreshForPermissionChange(nextFingerprint);
    };

    const channel = supabase
      .channel(`user-permissions-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'users',
          filter: `id=eq.${user.id}`,
        },
        (payload) => {
          const next = payload.new as Partial<User> | null;
          const nextFingerprint = buildPermissionsFingerprint(next);
          if (!nextFingerprint) {
            return;
          }

          refreshForPermissionChange(nextFingerprint);
        }
      )
      .subscribe();

    const interval = window.setInterval(() => {
      void checkCurrentUserFingerprint();
    }, 2000);

    const handleFocus = () => {
      void checkCurrentUserFingerprint();
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
      supabase.removeChannel(channel);
    };
  }, [pathname, refreshFingerprint, router, user]);

  return (
    <div className="h-screen flex overflow-hidden glass-backdrop">
      <AppNav
        user={user}
        collapsed={sidebarCollapsed}
        onCollapse={setSidebarCollapsed}
        onMenuClick={handleToggleSidebar}
        onNavigateStart={handleNavigationStart}
      />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <Header
          user={user}
          organization={organization}
          organizations={organizations}
          businessCentralStatus={businessCentralStatus}
          bcConnections={bcConnections}
          activeBcConnectionId={activeBcConnectionId}
          hasBcCredentials={hasBcCredentials}
          onMenuClick={handleToggleSidebar}
        />
        <Fragment key={refreshFingerprint ?? 'anonymous-user'}>{children}</Fragment>
      </div>
    </div>
  );
}
