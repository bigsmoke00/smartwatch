'use client';

import { useEffect, useRef } from 'react';
import * as d3 from 'd3';

export interface TopoNode {
  id: string; kind: string; name: string;
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  metadata?: any;
}
export interface TopoEdge {
  id: string; srcId: string; dstId: string;
  kind: string; protocol?: string; port?: number;
}

interface Props {
  nodes: TopoNode[];
  edges: TopoEdge[];
  onNodeClick?: (n: TopoNode) => void;
}

const STATUS_COLOR: Record<string, string> = {
  healthy: '#22c55e', degraded: '#f59e0b', down: '#ef4444', unknown: '#8a91a3',
};
const KIND_RADIUS: Record<string, number> = {
  server: 18, container: 11, database: 16, lb: 14, service: 12, external: 10,
};

export default function TopologyGraph({ nodes, edges, onNodeClick }: Props) {
  const ref = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const svg = d3.select(ref.current);
    svg.selectAll('*').remove();

    const w = ref.current.clientWidth || 800;
    const h = ref.current.clientHeight || 600;

    const g = svg.append('g');
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 3])
      .on('zoom', (e) => g.attr('transform', e.transform.toString()));
    svg.call(zoom as any);

    const linkData = edges.map((e) => ({ ...e, source: e.srcId, target: e.dstId }));
    const nodeData = nodes.map((n) => ({ ...n }));

    const sim = d3.forceSimulation(nodeData as any)
      .force('link', d3.forceLink(linkData as any).id((d: any) => d.id).distance(120).strength(0.4))
      .force('charge', d3.forceManyBody().strength(-260))
      .force('center', d3.forceCenter(w / 2, h / 2))
      .force('collision', d3.forceCollide().radius((d: any) => (KIND_RADIUS[d.kind] ?? 12) + 6));

    // Edges
    const linkSel = g.append('g')
      .attr('stroke', '#444')
      .attr('stroke-opacity', 0.6)
      .selectAll('line')
      .data(linkData)
      .enter()
      .append('line')
      .attr('stroke-width', (d: any) => d.kind === 'hosts' ? 2 : 1.5)
      .attr('stroke-dasharray', (d: any) => d.kind === 'hosts' ? '0' : '4 3');

    // Edge labels (port)
    const labelSel = g.append('g')
      .selectAll('text')
      .data(linkData.filter((e: any) => e.port))
      .enter()
      .append('text')
      .text((d: any) => `:${d.port}`)
      .attr('font-size', '9')
      .attr('fill', '#8a91a3')
      .attr('text-anchor', 'middle');

    // Nodes
    const nodeSel = g.append('g')
      .selectAll('g')
      .data(nodeData)
      .enter()
      .append('g')
      .style('cursor', 'pointer')
      .on('click', (_evt, d: any) => onNodeClick?.(d))
      .call(d3.drag<any, any>()
        .on('start', (e, d: any) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', (e, d: any) => { d.fx = e.x; d.fy = e.y; })
        .on('end', (e, d: any) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }) as any,
      );

    nodeSel.append('circle')
      .attr('r', (d: any) => KIND_RADIUS[d.kind] ?? 12)
      .attr('fill', (d: any) => STATUS_COLOR[d.status] ?? '#8a91a3')
      .attr('stroke', '#13161d')
      .attr('stroke-width', 2);

    nodeSel.append('text')
      .text((d: any) => kindIcon(d.kind))
      .attr('font-size', (d: any) => `${KIND_RADIUS[d.kind] ?? 12}`)
      .attr('text-anchor', 'middle')
      .attr('dy', '0.35em')
      .attr('fill', '#0b0d12')
      .style('pointer-events', 'none')
      .style('font-weight', '700')
      .style('font-family', 'ui-monospace, monospace');

    nodeSel.append('text')
      .text((d: any) => d.name.length > 24 ? d.name.slice(0, 22) + '…' : d.name)
      .attr('font-size', '10')
      .attr('fill', '#e6e8ee')
      .attr('text-anchor', 'middle')
      .attr('dy', (d: any) => (KIND_RADIUS[d.kind] ?? 12) + 12)
      .style('pointer-events', 'none');

    sim.on('tick', () => {
      linkSel
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y);
      labelSel
        .attr('x', (d: any) => (d.source.x + d.target.x) / 2)
        .attr('y', (d: any) => (d.source.y + d.target.y) / 2);
      nodeSel.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
    });

    return () => { sim.stop(); };
  }, [nodes, edges, onNodeClick]);

  return <svg ref={ref} className="w-full h-[78vh] bg-bg rounded border border-border" />;
}

function kindIcon(kind: string): string {
  const map: Record<string, string> = {
    server: '◈', container: '▢', database: '⬢', lb: '⇄', service: '⊙', external: '✷',
  };
  return map[kind] ?? '?';
}
