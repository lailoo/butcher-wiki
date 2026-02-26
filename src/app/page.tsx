import { ALL_DOMAINS } from '@/data/domains';
import { buildSearchContext } from '@/lib/search-context';
import { buildGraphData } from '@/lib/graph-data';
import { HomePageClient } from '@/components/home/HomePageClient';

export default function HomePage() {
  const domains = ALL_DOMAINS.map((d) => ({
    id: d.id,
    slug: d.slug,
    title: d.title,
    subtitle: d.subtitle,
    icon: d.icon,
    color: d.color,
    severity: d.severity,
    tags: d.tags,
    description: d.description,
    solution_count: d.solutions.length,
  }));
  const totalSolutions = ALL_DOMAINS.reduce((sum, d) => sum + d.solutions.length, 0);
  const uniqueProjects = [...new Set(ALL_DOMAINS.flatMap(d => d.solutions.map(s => s.project)))].length;
  const totalComparisons = ALL_DOMAINS.reduce((sum, d) => sum + d.comparison_dimensions.length, 0);
  const knowledgeContext = buildSearchContext();
  const graphData = buildGraphData();

  return (
    <HomePageClient
      domains={domains}
      totalSolutions={totalSolutions}
      uniqueProjects={uniqueProjects}
      totalComparisons={totalComparisons}
      knowledgeContext={knowledgeContext}
      graphData={graphData}
    />
  );
}
