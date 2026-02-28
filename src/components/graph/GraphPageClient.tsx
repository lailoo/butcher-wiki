'use client';

import { useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useTranslation } from 'react-i18next';
import { GraphLegend } from './GraphLegend';
import { GraphFilters } from './GraphFilters';
import { GraphTooltip } from './GraphTooltip';
import type { GraphData, GraphNode } from '@/lib/graph-data';
import type { GraphViewMode, GraphTheme } from './ForceGraph';

const ForceGraph = dynamic(() => import('./ForceGraph'), { ssr: false });

interface Props {
  graphData: GraphData;
}

export function GraphPageClient({ graphData }: Props) {
  const { t } = useTranslation();
  const [severityFilter, setSeverityFilter] = useState<Set<string>>(
    new Set(['critical', 'high', 'medium'])
  );
  const [viewMode, setViewMode] = useState<GraphViewMode>('project');
  const [graphTheme, setGraphTheme] = useState<GraphTheme>('default');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const filteredData = useMemo(() => {
    const visibleDomains = new Set(
      graphData.nodes
        .filter(n => n.type === 'domain' && n.severity && severityFilter.has(n.severity))
        .map(n => n.id)
    );
    const visibleLinks = graphData.links.filter(l => visibleDomains.has(l.target as string));
    const visibleProjects = new Set(visibleLinks.map(l => l.source as string));
    const visibleNodes = graphData.nodes.filter(
      n => visibleDomains.has(n.id) || visibleProjects.has(n.id)
    );
    return { nodes: visibleNodes, links: visibleLinks };
  }, [graphData, severityFilter]);

  const stats = useMemo(() => {
    const projects = filteredData.nodes.filter(n => n.type === 'project').length;
    const domains = filteredData.nodes.filter(n => n.type === 'domain').length;
    return { projects, domains, links: filteredData.links.length };
  }, [filteredData]);
  const handleNodeHover = (node: GraphNode | null, pos: { x: number; y: number }) => {
    setHoveredNode(node);
    setTooltipPos(pos);
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-12">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] mb-6">
        <a href="/" className="hover:text-[var(--text-secondary)] transition-colors cursor-pointer">{t('Home')}</a>
        <span>/</span>
        <span className="text-[var(--text-secondary)]">{t('Knowledge Graph')}</span>
      </div>

      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold mb-1">{t('Knowledge Graph')}</h1>
          <p className="text-sm text-[var(--text-muted)]">
            {stats.projects} {t('projects')} · {stats.domains} {t('domains')} · {stats.links} {t('connections')}
          </p>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          {/* View mode toggle */}
          <div className="flex items-center gap-1 rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] p-0.5">
            {(['project', 'domain'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => { setViewMode(mode); setSelectedNode(null); }}
                className="text-[11px] font-medium px-3 py-1 rounded-full transition-all duration-200 cursor-pointer"
                style={{
                  backgroundColor: viewMode === mode ? 'var(--accent-blue)' : 'transparent',
                  color: viewMode === mode ? '#fff' : 'var(--text-muted)',
                  opacity: viewMode === mode ? 1 : 0.7,
                }}
              >
                {mode === 'project' ? t('Project View') : t('Domain View')}
              </button>
            ))}
          </div>
          {/* Theme toggle */}
          <div className="flex items-center gap-1 rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] p-0.5">
            {(['default', 'cosmos'] as const).map(th => (
              <button
                key={th}
                onClick={() => setGraphTheme(th)}
                className="text-[11px] font-medium px-3 py-1 rounded-full transition-all duration-200 cursor-pointer"
                style={{
                  backgroundColor: graphTheme === th ? (th === 'cosmos' ? '#6366f1' : 'var(--accent-blue)') : 'transparent',
                  color: graphTheme === th ? '#fff' : 'var(--text-muted)',
                  opacity: graphTheme === th ? 1 : 0.7,
                }}
              >
                {th === 'default' ? t('Default') : t('Cosmos')}
              </button>
            ))}
          </div>
          <GraphFilters severityFilter={severityFilter} onSeverityChange={setSeverityFilter} />
        </div>
      </div>

      {/* Mobile fallback */}
      <div className="block md:hidden glass-card p-6 text-center">
        <p className="text-sm text-[var(--text-muted)] mb-3">{t('Knowledge graph requires a larger screen')}</p>
        <a href="/projects" className="text-sm text-[var(--accent-blue)] cursor-pointer">
          {t('View Project Index')} →
        </a>
      </div>

      {/* Desktop graph */}
      <div className="hidden md:block glass-card relative overflow-hidden" style={{ height: '70vh' }}>
        <ForceGraph
          data={filteredData}
          viewMode={viewMode}
          theme={graphTheme}
          selectedNode={selectedNode}
          onNodeSelect={setSelectedNode}
          onNodeHover={handleNodeHover}
        />
        <GraphLegend viewMode={viewMode} />
        {hoveredNode && <GraphTooltip node={hoveredNode} position={tooltipPos} />}
      </div>
    </div>
  );
}
