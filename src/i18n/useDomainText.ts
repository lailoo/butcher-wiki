'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

interface DomainTextFields {
  title: string;
  subtitle: string;
  description: string;
  sub_problems: string[];
  best_practices: string[];
  comparison_dimensions?: { name: string; values: Record<string, string> }[];
  solutions?: { source_id: string; title: string; description: string; design_philosophy?: string[]; migration_scenarios?: string[] }[];
}

interface UseDomainTextResult extends DomainTextFields {
  isTranslating: boolean;
  translationError: string | null;
}

// In-memory cache to avoid re-fetching during the same session
const translationCache = new Map<string, DomainTextFields>();
// Track in-flight requests to avoid duplicates
const pendingRequests = new Map<string, Promise<DomainTextFields | null>>();

async function fetchTranslation(domainId: string): Promise<DomainTextFields | null> {
  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'domain', id: domainId }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.translation as DomainTextFields;
  } catch {
    return null;
  }
}

/**
 * Hook that returns domain text fields in the current language.
 * When language is English and no translation exists, triggers on-demand LLM translation.
 */
export function useDomainText(domainId: string, original: DomainTextFields): UseDomainTextResult {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  const [translation, setTranslation] = useState<DomainTextFields | null>(
    translationCache.get(domainId) ?? null,
  );
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);

  const loadTranslation = useCallback(async () => {
    const cached = translationCache.get(domainId);
    if (cached) {
      setTranslation(cached);
      return;
    }

    let promise = pendingRequests.get(domainId);
    if (!promise) {
      setIsTranslating(true);
      promise = fetchTranslation(domainId);
      pendingRequests.set(domainId, promise);
    }

    const result = await promise;
    pendingRequests.delete(domainId);

    if (result) {
      translationCache.set(domainId, result);
      setTranslation(result);
      setTranslationError(null);
    } else {
      setTranslationError('Translation unavailable');
    }
    setIsTranslating(false);
  }, [domainId]);

  useEffect(() => {
    if (lang === 'en' && domainId) {
      loadTranslation();
    }
  }, [lang, domainId, loadTranslation]);

  // Return original Chinese when language is zh
  if (lang !== 'en' || (!translation && !isTranslating)) {
    return { ...original, isTranslating: false, translationError: null };
  }

  if (isTranslating && !translation) {
    return { ...original, isTranslating: true, translationError: null };
  }

  if (translation) {
    return {
      title: translation.title || original.title,
      subtitle: translation.subtitle || original.subtitle,
      description: translation.description || original.description,
      sub_problems: translation.sub_problems || original.sub_problems,
      best_practices: translation.best_practices || original.best_practices,
      comparison_dimensions: translation.comparison_dimensions || original.comparison_dimensions,
      solutions: translation.solutions || original.solutions,
      isTranslating: false,
      translationError: null,
    };
  }

  return { ...original, isTranslating, translationError };
}
