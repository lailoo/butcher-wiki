'use client';

import { useTranslation } from 'react-i18next';
import { ProjectCard, type ProjectEntry } from '@/components/project/ProjectCard';

export function ProjectsPageClient({ projects }: { projects: ProjectEntry[] }) {
  const { t } = useTranslation();

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] mb-6">
        <a href="/" className="hover:text-[var(--text-secondary)] transition-colors duration-200 cursor-pointer">{t('Home')}</a>
        <span>/</span>
        <span className="text-[var(--text-secondary)]">{t('Project Index')}</span>
      </div>

      <section className="mb-8">
        <h1 className="text-3xl font-bold mb-2">{t('Analyzed Projects')}</h1>
        <p className="text-base text-[var(--text-secondary)]">
          {t('projects_desc')}
        </p>
      </section>

      <div className="flex flex-col gap-4">
        {projects.map((p) => (
          <ProjectCard key={p.name} project={p} />
        ))}
      </div>
    </div>
  );
}
