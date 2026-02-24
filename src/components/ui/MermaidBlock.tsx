'use client';

import { useEffect, useRef, useState } from 'react';

let mermaidInitialized = false;

async function initMermaid() {
  if (mermaidInitialized) return;
  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    themeVariables: {
      primaryColor: '#1e3a5f',
      primaryTextColor: '#f1f5f9',
      primaryBorderColor: '#3b82f6',
      lineColor: '#64748b',
      secondaryColor: '#1e293b',
      tertiaryColor: '#0f172a',
      fontFamily: 'IBM Plex Sans, sans-serif',
      fontSize: '13px',
    },
    flowchart: { curve: 'basis', padding: 12 },
    securityLevel: 'loose',
  });
  mermaidInitialized = true;
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
