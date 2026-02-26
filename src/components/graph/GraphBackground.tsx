'use client';

import { useRef, useCallback, useEffect, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { GraphData, GraphNode } from '@/lib/graph-data';

function isLightTheme() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute('data-theme') === 'light';
}

export default function GraphBackground({ data }: { data: GraphData }) {
  const fgRef = useRef<any>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 360 });

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

  useEffect(() => {
    if (!fgRef.current) return;
    fgRef.current.d3Force('charge')?.strength(-100);
    fgRef.current.d3Force('link')?.distance(50);
  }, [data]);

  const paintNode = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const n = node as GraphNode & { x: number; y: number };
    if (!n.x || !n.y) return;
    const light = isLightTheme();
    const isProject = n.type === 'project';
    const radius = isProject ? 10 : 3;

    // Glow for projects
    if (isProject) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius + 4, 0, 2 * Math.PI);
      ctx.fillStyle = `${n.color}20`;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(n.x, n.y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = n.color;
    ctx.globalAlpha = isProject ? 1 : (light ? 0.5 : 0.4);
    ctx.fill();

    if (isProject) {
      ctx.strokeStyle = light ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.globalAlpha = 1;

    // Labels for projects
    if (isProject) {
      const fontSize = 11 / globalScale;
      ctx.font = `700 ${fontSize}px 'IBM Plex Sans', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = light ? 'rgba(15,23,42,0.95)' : 'rgba(241,245,249,0.85)';
      ctx.fillText(n.label, n.x, n.y + radius + 4);
    }
  }, []);

  const paintLink = useCallback((link: any, ctx: CanvasRenderingContext2D) => {
    const src = link.source as any;
    const tgt = link.target as any;
    if (!src.x || !tgt.x) return;
    const light = isLightTheme();

    ctx.beginPath();
    ctx.moveTo(src.x, src.y);
    ctx.lineTo(tgt.x, tgt.y);
    ctx.strokeStyle = light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }, []);

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <ForceGraph2D
        ref={fgRef}
        graphData={data}
        width={dimensions.width}
        height={dimensions.height}
        nodeCanvasObject={paintNode}
        linkCanvasObject={paintLink}
        cooldownTicks={80}
        d3AlphaDecay={0.03}
        d3VelocityDecay={0.4}
        backgroundColor="transparent"
        enableZoomInteraction={false}
        enablePanInteraction={false}
        enableNodeDrag={false}
      />
    </div>
  );
}
