'use client';

import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { GraphData, GraphNode } from '@/lib/graph-data';

export type GraphViewMode = 'project' | 'domain';
export type GraphTheme = 'default' | 'cosmos';

interface Props {
  data: GraphData;
  viewMode: GraphViewMode;
  theme: GraphTheme;
  selectedNode: string | null;
  onNodeSelect: (id: string | null) => void;
  onNodeHover: (node: GraphNode | null, pos: { x: number; y: number }) => void;
}

// Stable starfield — generated once per dimension, cached
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

/** Static starfield canvas behind the force graph */
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

function isLightTheme() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute('data-theme') === 'light';
}

export default function ForceGraph({ data, viewMode, theme, selectedNode, onNodeSelect, onNodeHover }: Props) {
  const fgRef = useRef<any>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const starsRef = useRef<ReturnType<typeof generateStars>>([]);
  const tickRef = useRef(0);

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

  // Adjust spacing based on view mode
  useEffect(() => {
    if (!fgRef.current) return;
    if (viewMode === 'domain') {
      // Domain view: many more primary nodes, need stronger repulsion
      fgRef.current.d3Force('charge')?.strength(-200);
      fgRef.current.d3Force('link')?.distance(40);
    } else {
      fgRef.current.d3Force('charge')?.strength(-120);
      fgRef.current.d3Force('link')?.distance(60);
    }
    fgRef.current.d3ReheatSimulation();
  }, [data, viewMode]);

  // Compute degree (link count) for each node
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

  // Radius from degree: sqrt scaling, clamped to [3, 18]
  const getRadius = useCallback((nodeId: string, nodeType: string) => {
    const degree = degreeMap.get(nodeId) || 0;
    if (viewMode === 'project') {
      // Project view: projects big, domains small (original behavior)
      return nodeType === 'project' ? 12 : 5;
    }
    // Domain view: size by degree
    if (nodeType === 'domain') {
      // domains: 3..18 based on how many projects connect
      return Math.max(3, Math.min(18, 3 + Math.sqrt(degree) * 4));
    }
    // projects in domain view: 3..10 based on how many domains they cover
    return Math.max(3, Math.min(10, 3 + Math.sqrt(degree) * 1.5));
  }, [degreeMap, viewMode]);

  // Label threshold: in domain view, only show labels for nodes with enough connections
  const shouldShowLabel = useCallback((nodeId: string, nodeType: string, globalScale: number) => {
    if (viewMode === 'project') {
      return nodeType === 'project' || globalScale > 1.2;
    }
    // Domain view: show label based on degree + zoom
    const degree = degreeMap.get(nodeId) || 0;
    if (nodeType === 'domain') {
      if (degree >= 3) return true;           // 3+ projects → always show
      if (degree >= 2 && globalScale > 0.8) return true;
      return globalScale > 1.5;               // rest only on zoom
    }
    // Projects in domain view
    if (degree >= 5 && globalScale > 0.6) return true;
    return globalScale > 1.5;
  }, [degreeMap, viewMode]);

  const isCosmos = theme === 'cosmos' && !isLightTheme();

  const paintNode = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const n = node as GraphNode & { x: number; y: number };
    if (!n.x || !n.y) return;
    const light = isLightTheme();
    const radius = getRadius(n.id, n.type);
    const isActive = !highlighted || highlighted.has(n.id);
    const alpha = isActive ? 1 : 0.12;

    ctx.globalAlpha = alpha;

    if (isCosmos) {
      // --- Cosmos theme: nebula glow ---
      // Outer nebula haze
      const outerR = radius * 3.5;
      const grad = ctx.createRadialGradient(n.x, n.y, radius * 0.5, n.x, n.y, outerR);
      grad.addColorStop(0, `${n.color}50`);
      grad.addColorStop(0.4, `${n.color}18`);
      grad.addColorStop(1, `${n.color}00`);
      ctx.beginPath();
      ctx.arc(n.x, n.y, outerR, 0, 2 * Math.PI);
      ctx.fillStyle = grad;
      ctx.fill();

      // Selected: pulsing ring
      if (selectedNode === n.id) {
        tickRef.current++;
        const pulse = 0.6 + Math.sin(tickRef.current * 0.08) * 0.4;
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius + 8, 0, 2 * Math.PI);
        ctx.strokeStyle = `${n.color}`;
        ctx.globalAlpha = alpha * pulse * 0.5;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = alpha;
      }

      // Core star
      const coreGrad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, radius);
      coreGrad.addColorStop(0, '#ffffff');
      coreGrad.addColorStop(0.3, n.color);
      coreGrad.addColorStop(1, `${n.color}80`);
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius, 0, 2 * Math.PI);
      ctx.fillStyle = coreGrad;
      ctx.fill();

      // Cross-flare for big nodes
      if (radius >= 8) {
        ctx.globalAlpha = alpha * 0.3;
        ctx.strokeStyle = n.color;
        ctx.lineWidth = 0.8;
        const flareLen = radius * 2;
        ctx.beginPath();
        ctx.moveTo(n.x - flareLen, n.y);
        ctx.lineTo(n.x + flareLen, n.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(n.x, n.y - flareLen);
        ctx.lineTo(n.x, n.y + flareLen);
        ctx.stroke();
        ctx.globalAlpha = alpha;
      }
    } else {
      // --- Default theme ---
      if (selectedNode === n.id) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius + 6, 0, 2 * Math.PI);
        ctx.fillStyle = `${n.color}40`;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, radius, 0, 2 * Math.PI);
      ctx.fillStyle = n.color;
      ctx.fill();

      if (radius >= 8) {
        ctx.strokeStyle = light ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.25)';
        ctx.lineWidth = radius >= 12 ? 2 : 1.5;
        ctx.stroke();
      }
    }

    // Label
    if (shouldShowLabel(n.id, n.type, globalScale)) {
      const isBig = radius >= 8;
      const fontSize = isBig ? 13 / globalScale : 10 / globalScale;
      ctx.font = `${isBig ? '700' : '500'} ${fontSize}px 'IBM Plex Sans', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      if (isCosmos) {
        // Cosmos: glowing text
        ctx.shadowColor = n.color;
        ctx.shadowBlur = 6;
        ctx.fillStyle = isActive ? 'rgba(220,230,255,0.95)' : 'rgba(220,230,255,0.1)';
        ctx.fillText(n.label, n.x, n.y + radius + 3);
        ctx.shadowBlur = 0;
      } else if (light) {
        ctx.fillStyle = isActive ? 'rgba(15,23,42,0.95)' : 'rgba(15,23,42,0.12)';
        ctx.fillText(n.label, n.x, n.y + radius + 3);
      } else {
        ctx.fillStyle = isActive ? 'rgba(241,245,249,0.9)' : 'rgba(241,245,249,0.1)';
        ctx.fillText(n.label, n.x, n.y + radius + 3);
      }
    }

    ctx.globalAlpha = 1;
  }, [selectedNode, highlighted, getRadius, shouldShowLabel, isCosmos]);

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

    if (isCosmos) {
      // Constellation line with gradient
      const srcNode = data.nodes.find(n => n.id === srcId);
      const tgtNode = data.nodes.find(n => n.id === tgtId);
      if (isActive && srcNode && tgtNode) {
        const grad = ctx.createLinearGradient(src.x, src.y, tgt.x, tgt.y);
        grad.addColorStop(0, `${srcNode.color}30`);
        grad.addColorStop(0.5, 'rgba(150,180,255,0.12)');
        grad.addColorStop(1, `${tgtNode.color}30`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1;
      } else {
        ctx.strokeStyle = 'rgba(100,130,200,0.03)';
        ctx.lineWidth = 0.5;
      }
    } else if (light) {
      ctx.strokeStyle = isActive ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.02)';
      ctx.lineWidth = isActive ? 1 : 0.5;
    } else {
      ctx.strokeStyle = isActive ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.02)';
      ctx.lineWidth = isActive ? 1 : 0.5;
    }
    ctx.stroke();
  }, [highlighted, isCosmos, data.nodes]);

  // Paint starfield background (cosmos theme only, in screen space)
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!isCosmos || !fgRef.current) return;
    // Grab the canvas element from the force graph
    const el = containerRef.current?.querySelector('canvas');
    if (el) canvasRef.current = el;
  });

  return (
    <div ref={containerRef} className="w-full h-full relative">
      {isCosmos && <CosmosOverlay stars={starsRef.current} width={dimensions.width} height={dimensions.height} />}
      <ForceGraph2D
        ref={fgRef}
        graphData={data}
        width={dimensions.width}
        height={dimensions.height}
        nodeCanvasObject={paintNode}
        nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
          const r = getRadius(node.id, node.type) + 2;
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
