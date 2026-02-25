'use client';

import { useEffect, useRef, useState } from 'react';

function isLightTheme() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute('data-theme') === 'light';
}

const darkVars = {
  background: '#0f172a',
  primaryColor: '#1e293b',
  primaryTextColor: '#e2e8f0',
  primaryBorderColor: '#475569',
  lineColor: '#64748b',
  secondaryColor: '#1a1f2e',
  secondaryTextColor: '#e2e8f0',
  secondaryBorderColor: '#475569',
  tertiaryColor: '#162032',
  tertiaryTextColor: '#e2e8f0',
  tertiaryBorderColor: '#475569',
  noteBkgColor: '#1e293b',
  noteTextColor: '#cbd5e1',
  noteBorderColor: '#334155',
  edgeLabelBackground: '#0f172a',
  clusterBkg: '#0c1322',
  clusterBorder: '#334155',
  mainBkg: '#1e293b',
};

const lightVars = {
  background: '#f8fafc',
  primaryColor: '#e2e8f0',
  primaryTextColor: '#0f172a',
  primaryBorderColor: '#94a3b8',
  lineColor: '#94a3b8',
  secondaryColor: '#f1f5f9',
  secondaryTextColor: '#0f172a',
  secondaryBorderColor: '#94a3b8',
  tertiaryColor: '#e8ecf1',
  tertiaryTextColor: '#0f172a',
  tertiaryBorderColor: '#94a3b8',
  noteBkgColor: '#f1f5f9',
  noteTextColor: '#334155',
  noteBorderColor: '#cbd5e1',
  edgeLabelBackground: '#f8fafc',
  clusterBkg: '#f1f5f9',
  clusterBorder: '#cbd5e1',
  mainBkg: '#e2e8f0',
};

let lastTheme: string | null = null;

async function initMermaid(force = false) {
  const currentTheme = isLightTheme() ? 'light' : 'dark';
  if (!force && lastTheme === currentTheme) return;
  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: {
      ...(currentTheme === 'light' ? lightVars : darkVars),
      fontFamily: 'IBM Plex Sans, sans-serif',
      fontSize: '13px',
    },
    flowchart: { curve: 'basis', padding: 16 },
    securityLevel: 'loose',
  });
  lastTheme = currentTheme;
}

export function MermaidBlock({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;

    (async () => {
      try {
        await initMermaid();
        const mermaid = (await import('mermaid')).default;
        const { svg: rendered } = await mermaid.render(id, code.trim());
        if (!cancelled) setSvg(rendered);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Mermaid render failed');
      }
    })();

    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return (
      <pre className="bg-[var(--bg-secondary)] border border-red-500/30 rounded-lg p-4 overflow-x-auto mb-4 text-xs leading-relaxed text-red-400">
        <code>{code}</code>
      </pre>
    );
  }

  if (!svg) {
    return (
      <div className="bg-[var(--bg-secondary)] border border-[var(--glass-border)] rounded-lg p-6 mb-4 flex items-center justify-center min-h-[80px]">
        <span className="text-xs text-[var(--text-muted)]">Loading diagram...</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="mermaid-container bg-[var(--bg-secondary)] border border-[var(--glass-border)] rounded-lg p-4 mb-4 overflow-x-auto flex justify-center"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
