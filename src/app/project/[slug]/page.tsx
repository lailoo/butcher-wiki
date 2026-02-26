import fs from 'fs';
import path from 'path';
import { notFound } from 'next/navigation';
import { ALL_PROJECTS, getProjectBySlug } from '@/data/projects';
import { ProjectDetailClient } from '@/components/project/ProjectDetailClient';

export function generateStaticParams() {
  return ALL_PROJECTS.map((p) => ({ slug: p.slug }));
}

function extractFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const lines = content.split('\n');
  const meta: Record<string, string> = {};
  let bodyStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('# ')) { bodyStart = i + 1; continue; }
    if (line === '') { bodyStart = i + 1; continue; }
    if (line.startsWith('> ')) {
      const match = line.slice(2).match(/^(.+?)[：:]\s*(.+)$/);
      if (match) meta[match[1].trim()] = match[2].trim();
      bodyStart = i + 1;
    } else {
      break;
    }
  }

  while (bodyStart < lines.length) {
    const line = lines[bodyStart].trim();
    if (line === '---' || line === '') { bodyStart++; } else { break; }
  }

  return { meta, body: lines.slice(bodyStart).join('\n') };
}

export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = getProjectBySlug(slug);
  if (!project) notFound();

  const filePath = path.join(process.cwd(), 'knowledge', 'projects', `${project.markdownFile}.md`);
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    notFound();
  }

  const { meta, body } = extractFrontmatter(content);

  return (
    <ProjectDetailClient
      name={project.name}
      slug={project.slug}
      repo={project.repo}
      language={project.language}
      description={project.description}
      domains={project.domains}
      meta={meta}
      body={body}
    />
  );
}
