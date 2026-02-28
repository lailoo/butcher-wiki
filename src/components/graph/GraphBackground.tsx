'use client';

import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { GraphData, GraphNode } from '@/lib/graph-data';

function isLightTheme() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute('data-theme') === 'light';
}

function generateStars(w: number, h: number, count: number) {
  const stars: { x: number; y: number; r: number; a: number }[] = [];
  let seed = w * 7 + h * 13;
  const rand = () => { seed = (seed * 16807 + 0) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < count; i++) {
    stars.push({
      x: rand() * w,
      y: rand() * h,
      r: rand() * 1.2 + 0.2,
      a: rand() * 0.5 + 0.15,
    });
  }
  return stars;
}

function CosmosOverlay({ stars, width, height }: { stars: { x: number; y: number; r: number; a: number }[]; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || stars.length === 0) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    for (const s of stars) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, 2 * Math.PI);
      ctx.fillStyle = `rgba(180,200,255,${s.a})`;
      ctx.fill();
    }
  }, [stars, width, height]);
  return <canvas ref={ref} className="absolute inset-0 pointer-events-none" style={{ width, height }} />;
}

export default function GraphBackground({ data }: { data: GraphData }) {
  const fgRef = useRef<any>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 360 });
  const starsRef = useRef<ReturnType<typeof generateStars>>([]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
      starsRef.current = generateStars(width, height, Math.floor(width * height / 800));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!fgRef.current) return;
    fgRef.current.d3Force('charge')?.strength(-100);
    fgRef.current.d3Force('link')?.distance(50);
  }, [data]);

  const isCosmos = !isLightTheme();

  const degreeMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of data.links) {
      const src = typeof l.source === 'object' ? (l.source as any).id : l.source;
      const tgt = typeof l.target === 'object' ? (l.target as any).id : l.target;
      map.set(src, (map.get(src) || 0) + 1);
      map.set(tgt, (map.get(tgt) || 0) + 1);
    }
    return map;
  }, [data.links]);

  const paintNode = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const n = node as GraphNode & { x: number; y: number };
    if (!n.x || !n.y) return;
    const light = isLightTheme();
    const isProject = n.type === 'project';
    const degree = degreeMap.get(n.id) || 0;
    const radius = isProject ? Math.max(6, Math.min(14, 6 + Math.sqrt(degree) * 2)) : 3;

    if (isCosmos) {
      // Nebula haze
      const outerR = radius * 3;
      const grad = ctx.createRadialGradient(n.x, n.y, radius * 0.5, n.x, n.y, outerR);
      grad.addColorStop(0, `${n.color}40`);
      grad.addColorStop(0.4, `${n.color}12`);
      grad.addColorStop(1, `${n.color}00`);
      ctx.beginPath();
      ctx.arc(n.x, n.y, outerR, 0, 2 * Math.PI);
      ctx.fillStyle = grad;
      ctx.fill();

      // Core star
      const coreGrad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, radius);
      coreGrad.addColorStop(0, '#ffffff');
      coreGrad.addColorStop(0.3, n.color);
      coreGrad.addColorStop(1, `${n.color}80`);
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius, 0, 2 * Math.PI);
      ctx.fillStyle = coreGrad;
      ctx.fill();

      // Cross-flare for project nodes
      if (isProject && radius >= 8) {
        ctx.globalAlpha = 0.25;
        ctx.strokeStyle = n.color;
        ctx.lineWidth = 0.6;
        const flareLen = radius * 1.8;
        ctx.beginPath();
        ctx.moveTo(n.x - flareLen, n.y);
        ctx.lineTo(n.x + flareLen, n.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(n.x, n.y - flareLen);
        ctx.lineTo(n.x, n.y + flareLen);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    } else {
      // Light mode fallback — flat style
      if (isProject) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius + 4, 0, 2 * Math.PI);
        ctx.fillStyle = `${n.color}20`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius, 0, 2 * Math.PI);
      ctx.fillStyle = n.color;
      ctx.globalAlpha = isProject ? 1 : 0.5;
      ctx.fill();
      if (isProject) {
        ctx.strokeStyle = 'rgba(0,0,0,0.1)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Labels for projects
    if (isProject) {
      const fontSize = 11 / globalScale;
      ctx.font = `700 ${fontSize}px 'IBM Plex Sans', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      if (isCosmos) {
        ctx.shadowColor = n.color;
        ctx.shadowBlur = 6;
        ctx.fillStyle = 'rgba(220,230,255,0.9)';
        ctx.fillText(n.label, n.x, n.y + radius + 3);
        ctx.shadowBlur = 0;
      } else {
        ctx.fillStyle = light ? 'rgba(15,23,42,0.95)' : 'rgba(241,245,249,0.85)';
        ctx.fillText(n.label, n.x, n.y + radius + 4);
      }
    }
  }, [isCosmos, degreeMap]);

  const paintLink = useCallback((link: any, ctx: CanvasRenderingContext2D) => {
    const src = link.source as any;
    const tgt = link.target as any;
    if (!src.x || !tgt.x) return;

    ctx.beginPath();
    ctx.moveTo(src.x, src.y);
    ctx.lineTo(tgt.x, tgt.y);

    if (isCosmos) {
      const srcNode = data.nodes.find(n => n.id === (typeof src === 'object' ? src.id : src));
      const tgtNode = data.nodes.find(n => n.id === (typeof tgt === 'object' ? tgt.id : tgt));
      if (srcNode && tgtNode) {
        const grad = ctx.createLinearGradient(src.x, src.y, tgt.x, tgt.y);
        grad.addColorStop(0, `${srcNode.color}20`);
        grad.addColorStop(0.5, 'rgba(150,180,255,0.08)');
        grad.addColorStop(1, `${tgtNode.color}20`);
        ctx.strokeStyle = grad;
      } else {
        ctx.strokeStyle = 'rgba(100,130,200,0.05)';
      }
      ctx.lineWidth = 0.5;
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 0.5;
    }
    ctx.stroke();
  }, [isCosmos, data.nodes]);

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      {isCosmos && <CosmosOverlay stars={starsRef.current} width={dimensions.width} height={dimensions.height} />}
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
