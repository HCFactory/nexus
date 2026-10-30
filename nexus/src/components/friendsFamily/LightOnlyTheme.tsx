'use client';

import { useLayoutEffect, type ReactNode } from 'react';

const FORCE_LIGHT_SCRIPT = `(function(){var r=document.documentElement;r.classList.remove('dark');r.classList.add('light');r.style.colorScheme='light';})();`;

function forceLight(root: HTMLElement) {
  if (root.classList.contains('dark') || !root.classList.contains('light')) {
    root.classList.remove('dark');
    root.classList.add('light');
  }
  if (root.style.colorScheme !== 'light') root.style.colorScheme = 'light';
}

/** Keeps the standalone Friends & Family workflow in light mode for signed-out
 * visitors without changing the saved application theme after they leave it.
 * next-themes re-applies the stored theme after hydration, so the root is
 * watched and corrected for as long as this component is mounted. */
export function LightOnlyTheme({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previousClassName = root.className;
    const previousColorScheme = root.style.colorScheme;

    forceLight(root);
    const observer = new MutationObserver(() => forceLight(root));
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'style'] });

    return () => {
      observer.disconnect();
      root.className = previousClassName;
      root.style.colorScheme = previousColorScheme;
    };
  }, []);

  return (
    <>
      {/* Runs during HTML parsing, after next-themes' script, to avoid a dark flash. */}
      <script dangerouslySetInnerHTML={{ __html: FORCE_LIGHT_SCRIPT }} />
      {children}
    </>
  );
}
