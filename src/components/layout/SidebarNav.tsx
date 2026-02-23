'use client';

import { useTranslation } from 'react-i18next';

interface SidebarItem {
  label: string;
  href: string;
  children?: { label: string; href: string }[];
}

interface SidebarNavProps {
  items: SidebarItem[];
}

export function SidebarNav({ items }: SidebarNavProps) {
  const { t } = useTranslation();

  return (
    <nav className="glass-card p-4">
      <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)] mb-3">{t('Table of Contents')}</p>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
              className="block text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors duration-200 py-1 cursor-pointer"
            >
              {item.label}
            </a>
            {item.children && (
              <ul className="ml-3 border-l border-[var(--glass-border)] pl-3 space-y-0.5">
                {item.children.map((child) => (
                  <li key={child.href}>
                    <a
                      href={child.href}
                      className="block text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors duration-200 py-0.5 cursor-pointer"
                    >
                      {child.label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
