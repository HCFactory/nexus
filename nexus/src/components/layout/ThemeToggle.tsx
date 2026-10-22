'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { Sun, Moon } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

interface ThemeToggleProps {
  collapsed?: boolean;
}

export function ThemeToggle({ collapsed = false }: ThemeToggleProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted && resolvedTheme === 'dark';

  const toggle = () => setTheme(isDark ? 'light' : 'dark');

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label="Toggle theme"
        aria-pressed={isDark}
        suppressHydrationWarning
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-md mx-auto',
          'text-sidebar-foreground/70 hover:text-sidebar-foreground',
          'hover:bg-sidebar-accent transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring'
        )}
      >
        {mounted && isDark ? (
          <Moon className="h-4 w-4" />
        ) : (
          <Sun className="h-4 w-4" />
        )}
      </button>
    );
  }

  return (
    <div
      className="flex items-center justify-between gap-3 px-2 py-1.5 rounded-md"
      suppressHydrationWarning
    >
      <div className="flex items-center gap-2 text-sm text-sidebar-foreground/80">
        <span>Theme</span>
      </div>
      <div className="flex items-center gap-2">
        <Sun
          className={cn(
            'h-4 w-4 transition-colors',
            mounted && !isDark ? 'text-primary' : 'text-sidebar-foreground/50'
          )}
        />
        <Switch
          checked={isDark}
          onCheckedChange={toggle}
          aria-label="Toggle theme"
          disabled={!mounted}
        />
        <Moon
          className={cn(
            'h-4 w-4 transition-colors',
            mounted && isDark ? 'text-primary' : 'text-sidebar-foreground/50'
          )}
        />
      </div>
    </div>
  );
}
