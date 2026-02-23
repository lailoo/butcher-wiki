'use client';

import { useTranslation } from 'react-i18next';
import { SearchProvider } from '@/components/search/SearchProvider';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { LanguageToggle } from '@/i18n/LanguageToggle';

export function NavBar() {
  const { t } = useTranslation();

  return (
    <nav className="fixed top-4 left-4 right-4 z-50 glass-card px-6 py-3">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <a href="/" className="flex items-center gap-3 cursor-pointer">
          <svg className="w-6 h-6 text-[var(--accent-blue)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 2l9 9" /><path d="M12 11l9-9" /><path d="M12 11v11" /><path d="M8 22h8" />
          </svg>
          <span className="text-lg font-semibold tracking-tight">Butcher Wiki</span>
        </a>
        <div className="flex items-center gap-6 text-sm text-[var(--text-secondary)]">
          <a href="/" className="hover:text-[var(--text-primary)] transition-colors duration-200 cursor-pointer">{t('Problem Domains')}</a>
          <a href="/projects" className="hover:text-[var(--text-primary)] transition-colors duration-200 cursor-pointer">{t('Project Index')}</a>
          <a href="/scan" className="hover:text-[var(--text-primary)] transition-colors duration-200 cursor-pointer">{t('Scan New Project')}</a>
          <a href="/trending" className="hover:text-[var(--text-primary)] transition-colors duration-200 cursor-pointer">{t('Trending')}</a>
          <SearchProvider />
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
