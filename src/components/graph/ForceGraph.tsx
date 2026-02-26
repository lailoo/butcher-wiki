'use client';

import { useRef, useCallback, useEffect, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { GraphData, GraphNode } from '@/lib/graph-data';

interface Props {
  data: GraphData;
  selectedNode: string | null;
  onNodeSelect: (id: string | null) => void;
  onNodeHover: (node: GraphNode | null, pos: { x: number; y: number }) => void;
}

function isLightTheme() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute('data-theme') === 'light';
}

export default function ForceGraph({ data, selectedNode, onNodeSelect, onNodeHover }: Props) {
  const fgRef = useRef<any>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Increase spacing between nodes
  useEffect(() => {
    if (!fgRef.current) return;
    fgRef.current.d3Force('charge')?.strength(-120);
    fgRef.current.d3Force('link')?.distance(60);
  }, [data]);

  const connectedSet = useCallback((nodeId: string | null) => {
    if (!nodeId) return null;
    const set = new Set<string>([nodeId]);
    for (const l of data.links) {
      const src = typeof l.source === 'object' ? (l.source as any).id : l.source;
      const tgt = typeof l.target === 'object' ? (l.target as any).id : l.target;
      if (src === nodeId) set.add(tgt);
      if (tgt === nodeId) set.add(src);
    }
    return set;
  }, [data.links]);

  const highlighted = connectedSet(selectedNode);

  const paintNode = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const n = node as GraphNode & { x: number; y: number };
    if (!n.x || !n.y) return;
    const light = isLightTheme();
    const isProject = n.type === 'project';
    const radius = isProject ? 12 : 5;
    const isActive = !highlighted || highlighted.has(n.id);
    const alpha = isActive ? 1 : 0.12;

    ctx.globalAlpha = alpha;

    // Glow for selected
    if (selectedNode === n.id) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius + 6, 0, 2 * Math.PI);
      ctx.fillStyle = `${n.color}40`;
      ctx.fill();
    }

    // Node circle
    ctx.beginPath();
    ctx.arc(n.x, n.y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = n.color;
    ctx.fill();

    if (isProject) {
      ctx.strokeStyle = light ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Label — always show for projects, show domains at zoom
    if (isProject || globalScale > 1.2) {
      const fontSize = isProject ? 13 / globalScale : 10 / globalScale;
      ctx.font = `${isProject ? '700' : '500'} ${fontSize}px 'IBM Plex Sans', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      if (light) {
        ctx.fillStyle = isActive ? 'rgba(15,23,42,0.95)' : 'rgba(15,23,42,0.12)';
      } else {
        ctx.fillStyle = isActive ? 'rgba(241,245,249,0.9)' : 'rgba(241,245,249,0.1)';
      }
      ctx.fillText(n.label, n.x, n.y + radius + 3);
    }

    ctx.globalAlpha = 1;
  }, [selectedNode, highlighted]);

  const paintLink = useCallback((link: any, ctx: CanvasRenderingContext2D) => {
    const src = link.source as any;
    const tgt = link.target as any;
    if (!src.x || !tgt.x) return;
    const light = isLightTheme();

    const srcId = typeof src === 'object' ? src.id : src;
    const tgtId = typeof tgt === 'object' ? tgt.id : tgt;
    const isActive = !highlighted || (highlighted.has(srcId) && highlighted.has(tgtId));

    ctx.beginPath();
    ctx.moveTo(src.x, src.y);
    ctx.lineTo(tgt.x, tgt.y);
    if (light) {
      ctx.strokeStyle = isActive ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.02)';
    } else {
      ctx.strokeStyle = isActive ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.02)';
    }
    ctx.lineWidth = isActive ? 1 : 0.5;
    ctx.stroke();
  }, [highlighted]);

  return (
    <div ref={containerRef} className="w-full h-full">
      <ForceGraph2D
        ref={fgRef}
        graphData={data}
        width={dimensions.width}
        height={dimensions.height}
        nodeCanvasObject={paintNode}
        nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
          const r = node.type === 'project' ? 14 : 7;
          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        }}
        linkCanvasObject={paintLink}
        onNodeHover={(node: any) => {
          if (containerRef.current) {
            containerRef.current.style.cursor = node ? 'pointer' : 'default';
          }
          if (node && fgRef.current) {
            const coords = fgRef.current.graph2ScreenCoords(node.x, node.y);
            onNodeHover(node as GraphNode, { x: coords.x, y: coords.y });
          } else {
            onNodeHover(null, { x: 0, y: 0 });
          }
        }}
        onNodeClick={(node: any) => {
          const n = node as GraphNode;
          onNodeSelect(selectedNode === n.id ? null : n.id);
        }}
        onBackgroundClick={() => onNodeSelect(null)}
        cooldownTicks={100}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        backgroundColor="transparent"
        enableNodeDrag={true}
      />
    </div>
  );
}
