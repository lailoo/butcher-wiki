import fs from 'fs';
import path from 'path';
import { notFound } from 'next/navigation';
import { KNOWLEDGE_DOCS, getKnowledgeDocBySlug } from '@/data/knowledge-docs';
import { ALL_DOMAINS } from '@/data/domains';
import { KnowledgePageClient } from '@/components/knowledge/KnowledgePageClient';

export function generateStaticParams() {
  return KNOWLEDGE_DOCS.map((d) => ({ slug: d.slug }));
}

/** 从 markdown 开头的 blockquote 中提取元数据 */
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

export default async function KnowledgePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = getKnowledgeDocBySlug(slug);
  if (!doc) notFound();

  const filePath = path.join(process.cwd(), 'knowledge', 'solutions', `${doc.filename}.md`);
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    notFound();
  }

  const domain = ALL_DOMAINS.find(d => d.id === doc.domain_id) ?? null;
  const { meta, body } = extractFrontmatter(content);

  return (
    <KnowledgePageClient
      doc={{ title: doc.title, domain_id: doc.domain_id, project: doc.project, filename: doc.filename }}
      domain={domain ? { id: domain.id, slug: domain.slug, title: domain.title } : null}
      meta={meta}
      body={body}
      rawContent={content}
    />
  );
}
