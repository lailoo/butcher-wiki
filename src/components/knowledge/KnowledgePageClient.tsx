'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useDomainText } from '@/i18n/useDomainText';
import { MarkdownRenderer } from '@/components/ui/MarkdownRenderer';
import { CopyContextButton } from '@/components/ui/CopyContextButton';

interface KnowledgePageClientProps {
  doc: { title: string; domain_id: string; project: string; filename: string };
  domain: { id: string; slug: string; title: string } | null;
  meta: Record<string, string>;
  body: string;
  rawContent: string;
}

// In-memory cache for solution translations
const solutionCache = new Map<string, string>();
const pendingSolutions = new Map<string, Promise<string | null>>();

async function fetchSolutionTranslation(filename: string): Promise<string | null> {
  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'solution', filename }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.content as string;
  } catch {
    return null;
  }
}

interface ParsedTranslation {
  title: string | null;
  meta: Record<string, string>;
  body: string;
}

/** Parse translated markdown into title, meta (blockquotes), and body */
function parseTranslation(content: string): ParsedTranslation {
  const lines = content.split('\n');
  let title: string | null = null;
  const meta: Record<string, string> = {};
  let bodyStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('# ') && !title) {
      title = line.slice(2).trim();
      bodyStart = i + 1;
    } else if (line.startsWith('> ')) {
      const match = line.slice(2).match(/^(.+?)[：:]\s*(.+)$/);
      if (match) meta[match[1].trim()] = match[2].trim();
      bodyStart = i + 1;
    } else if (line === '' || line === '---') {
      bodyStart = i + 1;
    } else {
      break;
    }
  }

  return { title, meta, body: lines.slice(bodyStart).join('\n') };
}

export function KnowledgePageClient({ doc, domain, meta, body, rawContent }: KnowledgePageClientProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const localDomain = useDomainText(domain?.id ?? '', {
    title: domain?.title ?? '',
    subtitle: '',
    description: '',
    sub_problems: [],
    best_practices: [],
  });

  const [translatedBody, setTranslatedBody] = useState<string | null>(
    solutionCache.get(doc.filename) ?? null,
  );
  const [isTranslating, setIsTranslating] = useState(false);

  const loadTranslation = useCallback(async () => {
    const cached = solutionCache.get(doc.filename);
    if (cached) {
      setTranslatedBody(cached);
      return;
    }

    let promise = pendingSolutions.get(doc.filename);
    if (!promise) {
      setIsTranslating(true);
      promise = fetchSolutionTranslation(doc.filename);
      pendingSolutions.set(doc.filename, promise);
    }

    const result = await promise;
    pendingSolutions.delete(doc.filename);

    if (result) {
      solutionCache.set(doc.filename, result);
      setTranslatedBody(result);
    }
    setIsTranslating(false);
  }, [doc.filename]);

  useEffect(() => {
    if (lang === 'en' && doc.filename) {
      loadTranslation();
    }
  }, [lang, doc.filename, loadTranslation]);

  const parsed = translatedBody ? parseTranslation(translatedBody) : null;
  const isEn = lang === 'en';
  const displayBody = isEn && parsed ? parsed.body : body;
  const displayTitle = isEn && parsed?.title ? parsed.title : doc.title;
  const displayMeta = isEn && parsed && Object.keys(parsed.meta).length > 0 ? parsed.meta : meta;

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] mb-6 flex-wrap">
        <a href="/" className="hover:text-[var(--text-secondary)] transition-colors cursor-pointer">{t('Problem Domains')}</a>
        <span>/</span>
        {domain && (
          <>
            <a href={`/domain/${domain.slug}`} className="hover:text-[var(--text-secondary)] transition-colors cursor-pointer">
              {domain.id} {localDomain.title || domain.title}
            </a>
            <span>/</span>
          </>
        )}
        <span className="text-[var(--text-secondary)]">{doc.project}</span>
      </div>

      <div className="flex items-center gap-3 mb-2">
        <h1 className="text-2xl font-bold">{displayTitle}</h1>
        <CopyContextButton text={rawContent} label={t('Copy doc content')} iconOnly />
      </div>
      <div className="flex items-center gap-3 text-xs text-[var(--text-muted)] mb-6">
        <span className="rounded-full border border-[var(--glass-border)] px-2 py-0.5">{doc.domain_id}</span>
        <span className="rounded-full border border-[var(--glass-border)] px-2 py-0.5">{doc.project}</span>
      </div>

      {Object.keys(displayMeta).length > 0 && (
        <div className="rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg)] p-4 mb-8 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            {Object.entries(displayMeta).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-[var(--text-muted)] whitespace-nowrap">{key}</dt>
                <dd className="text-[var(--text-secondary)] break-all">
                  {value.startsWith('http') ? (
                    <a href={value} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">{value}</a>
                  ) : value.includes('`') ? (
                    <span>{value.replace(/`/g, '')}</span>
                  ) : value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <article className="prose-custom">
        {isTranslating && !translatedBody && (
          <div className="text-sm text-[var(--text-muted)] mb-4 flex items-center gap-2">
            <span className="inline-block w-3 h-3 border-2 border-[var(--accent-blue)] border-t-transparent rounded-full animate-spin" />
            {t('Translating...')}
          </div>
        )}
        <MarkdownRenderer content={displayBody} />
      </article>
    </div>
  );
}
