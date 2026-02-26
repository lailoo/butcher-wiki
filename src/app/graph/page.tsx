import { buildGraphData } from '@/lib/graph-data';
import { GraphPageClient } from '@/components/graph/GraphPageClient';

export default function GraphPage() {
  const graphData = buildGraphData();
  return <GraphPageClient graphData={graphData} />;
}
