import { ALL_DOMAINS, getDomainBySlug } from '@/data/domains';
import { findKnowledgeDoc } from '@/data/knowledge-docs';
import { buildDomainContext } from '@/lib/search-context';
import { notFound } from 'next/navigation';
import { DomainPageClient } from '@/components/domain/DomainPageClient';

export function generateStaticParams() {
  return ALL_DOMAINS.map((d) => ({ slug: d.slug }));
}

export default async function DomainPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const domain = getDomainBySlug(slug);
  if (!domain) notFound();

  const domainContext = buildDomainContext(domain.id);

  // Pre-compute knowledge doc slugs for each solution
  const knowledgeDocSlugs: Record<string, string | undefined> = {};
  for (const s of domain.solutions) {
    const doc = findKnowledgeDoc(domain.id, s.project);
    knowledgeDocSlugs[`${domain.id}-${s.project}`] = doc?.slug;
  }

  return <DomainPageClient domain={domain} domainContext={domainContext} knowledgeDocSlugs={knowledgeDocSlugs} />;
}
