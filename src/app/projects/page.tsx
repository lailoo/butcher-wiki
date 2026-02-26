import { ALL_DOMAINS } from '@/data/domains';
import { findKnowledgeDoc } from '@/data/knowledge-docs';
import { ALL_PROJECTS } from '@/data/projects';
import { type ProjectEntry } from '@/components/project/ProjectCard';
import { ProjectsPageClient } from '@/components/project/ProjectsPageClient';

function aggregateProjects(): ProjectEntry[] {
  const map = new Map<string, ProjectEntry>();

  for (const domain of ALL_DOMAINS) {
    for (const sol of domain.solutions) {
      let entry = map.get(sol.project);
      if (!entry) {
        const profile = ALL_PROJECTS.find(p => p.name.toLowerCase() === sol.project.toLowerCase());
        entry = { name: sol.project, repo: sol.repo, domains: [], profileSlug: profile?.slug };
        map.set(sol.project, entry);
      }
      if (!entry.domains.some(d => d.id === domain.id)) {
        const doc = findKnowledgeDoc(domain.id, sol.project);
        entry.domains.push({
          id: domain.id,
          slug: domain.slug,
          title: domain.title,
          icon: domain.icon,
          color: domain.color,
          solutionTitle: sol.title,
          knowledgeSlug: doc?.slug,
        });
      }
      if (!entry.repo && sol.repo) entry.repo = sol.repo;
    }
  }

  return [...map.values()].sort((a, b) => b.domains.length - a.domains.length);
}

export default function ProjectsPage() {
  const projects = aggregateProjects();
  return <ProjectsPageClient projects={projects} />;
}
