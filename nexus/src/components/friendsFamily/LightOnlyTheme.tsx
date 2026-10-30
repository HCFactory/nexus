'use client';

import { useLayoutEffect, type ReactNode } from 'react';

/** Keeps the standalone Friends & Family workflow in light mode without
 * changing the visitor's saved application theme after they leave it. */
export function LightOnlyTheme({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previousClassName = root.className;
    const previousColorScheme = root.style.colorScheme;

    root.classList.remove('dark', 'light');
    root.classList.add('light');
    root.style.colorScheme = 'light';

    return () => {
      root.className = previousClassName;
      root.style.colorScheme = previousColorScheme;
    };
  }, []);

  return <>{children}</>;
}
