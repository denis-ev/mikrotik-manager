import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { RefreshCw, GitBranch } from 'lucide-react';
import { topologyApi } from '../services/api';
import type { TopologyDevice, TopologyLink, ExternalTopologyNode } from '../types';
import clsx from 'clsx';
import { useThemeStore } from '../store/themeStore';

// helper to derive device class from LLDP capabilities
function capsLabel(caps: string | undefined): string {
  if (!caps) return '';
  const c = caps.toLowerCase();
  if (c.includes('bridge'))  return 'Switch';
  if (c.includes('router'))  return 'Router';
  if (c.includes('wlan-ap')) return 'AP';
  if (c.includes('telephone')) return 'Phone';
  return '';
}

const statusColor: Record<string, string> = {
  online: '#22c55e',
  offline: '#ef4444',
  unknown: '#94a3b8',
};

const deviceIcon: Record<string, string> = {
  router: '⇌',
  switch: '⊞',
  wireless_ap: '⊙',
  other: '◈',
};

const handleStyle = { opacity: 0, width: 8, height: 8 };

function DeviceNode({ data }: { data: Record<string, unknown> }) {
  const device = data as unknown as TopologyDevice & { isRootBridge: boolean };
  return (
    <div
      className={clsx('card px-3 py-2 min-w-[140px] text-xs shadow-md')}
      style={{
        borderColor: device.isRootBridge ? '#f59e0b' : statusColor[device.status],
        borderWidth: device.isRootBridge ? 2 : 1,
      }}
    >
      <Handle type="target" position={Position.Top}    isConnectable={false} style={handleStyle} />
      <Handle type="target" position={Position.Left}   isConnectable={false} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} style={handleStyle} />
      <Handle type="source" position={Position.Right}  isConnectable={false} style={handleStyle} />
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-base leading-none">{deviceIcon[device.device_type] || '◈'}</span>
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ background: statusColor[device.status] }}
        />
        <span className="font-semibold truncate text-gray-900 dark:text-white">
          {device.name}
        </span>
        {device.isRootBridge && (
          <span title="Root Bridge" className="ml-auto text-amber-500 text-xs font-bold">★</span>
        )}
      </div>
      <div className="font-mono text-gray-400 dark:text-slate-500">{device.ip_address}</div>
      {device.model && (
        <div className="text-gray-400 dark:text-slate-500 truncate">{device.model}</div>
      )}
    </div>
  );
}

function ExternalNode({ data }: { data: Record<string, unknown> }) {
  const node = data as unknown as ExternalTopologyNode;

  // Shared segment synthetic node
  if (node.caps === 'segment') {
    return (
      <div
        className="px-3 py-2 min-w-[140px] text-xs rounded-lg bg-amber-50 dark:bg-amber-900/20 shadow-sm"
        style={{ border: '2px dashed #f59e0b' }}
      >
        <Handle type="target" position={Position.Top}    isConnectable={false} style={handleStyle} />
        <Handle type="target" position={Position.Left}   isConnectable={false} style={handleStyle} />
        <Handle type="source" position={Position.Bottom} isConnectable={false} style={handleStyle} />
        <Handle type="source" position={Position.Right}  isConnectable={false} style={handleStyle} />
        <div className="font-semibold text-amber-700 dark:text-amber-400 mb-0.5">⊕ Shared Segment</div>
        {node.platform && (
          <div className="text-amber-600 dark:text-amber-500">{node.platform}</div>
        )}
        <div className="text-amber-400 dark:text-amber-600 mt-0.5 text-[10px]">
          Unmanaged L2 switch/hub
        </div>
      </div>
    );
  }

  const cl = capsLabel(node.caps);
  return (
    <div
      className="px-3 py-2 min-w-[130px] text-xs rounded-lg bg-gray-100 dark:bg-slate-700/60 shadow-sm"
      style={{ border: '1.5px dashed #94a3b8' }}
    >
      <Handle type="target" position={Position.Top}    isConnectable={false} style={handleStyle} />
      <Handle type="target" position={Position.Left}   isConnectable={false} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} style={handleStyle} />
      <Handle type="source" position={Position.Right}  isConnectable={false} style={handleStyle} />
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-base leading-none text-gray-400">◌</span>
        <span className="font-semibold truncate text-gray-600 dark:text-slate-300">
          {node.name}{cl ? ` (${cl})` : ''}
        </span>
      </div>
      {node.address && (
        <div className="font-mono text-gray-400 dark:text-slate-500">{node.address}</div>
      )}
      {node.platform && (
        <div className="text-gray-400 dark:text-slate-500 truncate">{node.platform}</div>
      )}
      <div className="text-gray-300 dark:text-slate-600 mt-0.5">External</div>
    </div>
  );
}

const nodeTypes = { deviceNode: DeviceNode, externalNode: ExternalNode };

/** Layout box (React Flow uses top-left origin for `position`). */
const NODE_W = 160;
const NODE_H = 80;
/** Conservative hit box so labels / padding do not overlap adjacent nodes */
const NODE_LAYOUT_W = 220;
const NODE_LAYOUT_H = 110;
const H_GAP = 60;             // horizontal spacing between sibling nodes
const V_GAP = 90;             // vertical spacing between tree levels
const COMPONENT_GAP = 120;    // gap between disconnected subgraphs
/** Horizontal slot for tree layout — use layout box width so siblings start far enough apart */
const NODE_SLOT = NODE_LAYOUT_W + H_GAP;
const OVERLAP_SEP = 16;       // extra gap when separating overlapping nodes

export interface TopologyLayoutOptions {
  /** When true, nodes at the same tree depth share one horizontal row (aligned Y). */
  alignByDepth: boolean;
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Push nodes apart until bounding boxes (layout size) no longer overlap. */
function resolveOverlaps(
  positions: Map<string, { x: number; y: number }>,
  opts?: { maxIterations?: number }
): void {
  const maxIt = opts?.maxIterations ?? 100;
  const ids = [...positions.keys()];
  if (ids.length < 2) return;

  const w = NODE_LAYOUT_W;
  const h = NODE_LAYOUT_H;

  for (let round = 0; round < maxIt; round++) {
    let moved = false;
    const boxes = ids.map((id) => {
      const p = positions.get(id)!;
      return { id, x: p.x, y: p.y, w, h };
    });
    boxes.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i];
        const B = boxes[j];
        if (!rectsOverlap(A, B)) continue;

        const dx = Math.abs((B.x + B.w / 2) - (A.x + A.w / 2));
        const dy = Math.abs((B.y + B.h / 2) - (A.y + A.h / 2));
        const pushDown = dy <= dx * 0.85;

        if (pushDown) {
          const newY = A.y + A.h + OVERLAP_SEP;
          if (newY !== B.y) {
            positions.set(B.id, { x: B.x, y: newY });
            B.y = newY;
            moved = true;
          }
        } else {
          const shift = B.x >= A.x ? 1 : -1;
          const newX = B.x + shift * (Math.min(w, h) / 2 + OVERLAP_SEP);
          if (newX !== B.x) {
            positions.set(B.id, { x: newX, y: B.y });
            B.x = newX;
            moved = true;
          }
        }
      }
    }
    if (!moved) break;
  }
}

/** Same-depth nodes in one row, non-overlapping horizontally (strict grid). */
function layoutAlignedRows(
  positions: Map<string, { x: number; y: number }>,
  depthById: Map<string, number>
): void {
  const rowH = NODE_H + V_GAP;
  const byDepth = new Map<number, string[]>();
  for (const [id, d] of depthById) {
    if (!positions.has(id)) continue;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(id);
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  for (const d of depths) {
    const rowIds = byDepth.get(d)!;
    rowIds.sort((a, b) => (positions.get(a)!.x - positions.get(b)!.x));
    const slot = NODE_LAYOUT_W + H_GAP;
    const rowW = rowIds.length * slot - H_GAP;
    let x = -rowW / 2;
    const y = d * rowH;
    for (const id of rowIds) {
      positions.set(id, { x, y });
      x += slot;
    }
  }
}

function buildGraph(
  devices: TopologyDevice[],
  externalNodes: ExternalTopologyNode[],
  links: TopologyLink[],
  layout: TopologyLayoutOptions
): { nodes: Node[]; edges: Edge[] } {

  // ── Shared-segment detection ────────────────────────────────────────────────
  // LLDP is 802.1AB point-to-point — always a direct link.
  // CDP and MNDP are L2 multicast and flood across unmanaged switches, so a port
  // seeing multiple non-LLDP neighbors means they're all on a shared segment,
  // not individually wired to this device.

  const lldpLinks    = links.filter((l) => l.link_type === 'lldp');
  const nonLldpLinks = links.filter((l) => l.link_type !== 'lldp' && !!l.from_device_id);

  // Group non-LLDP links by (from_device_id, from_interface)
  const portGroupMap = new Map<string, TopologyLink[]>();
  for (const link of nonLldpLinks) {
    const pk = `${link.from_device_id}::${link.from_interface ?? ''}`;
    if (!portGroupMap.has(pk)) portGroupMap.set(pk, []);
    portGroupMap.get(pk)!.push(link);
  }

  // Port groups with ≥2 neighbors → shared segment; 1 neighbor → keep as direct
  const sharedPortKeys = [...portGroupMap.keys()].filter((pk) => portGroupMap.get(pk)!.length >= 2);
  const soloNonLldp   = [...portGroupMap.values()].filter((g) => g.length < 2).flat();

  // Stable key to identify a neighbor across links
  const nKey = (l: TopologyLink) =>
    l.to_device_id      ? `d:${l.to_device_id}` :
    l.neighbor_mac      ? `m:${l.neighbor_mac.toLowerCase()}` :
    l.neighbor_address  ? `a:${l.neighbor_address}` :
                          `i:${l.neighbor_identity ?? ''}`;

  // Union-find: merge port groups that see any common neighbor (same physical segment)
  const ufParent = new Map<string, string>(sharedPortKeys.map((k) => [k, k]));
  const ufFind = (k: string): string => {
    if (ufParent.get(k) !== k) ufParent.set(k, ufFind(ufParent.get(k)!));
    return ufParent.get(k)!;
  };
  const ufUnion = (a: string, b: string) => ufParent.set(ufFind(a), ufFind(b));

  const pkNeighborSets = new Map<string, Set<string>>();
  for (const pk of sharedPortKeys) {
    pkNeighborSets.set(pk, new Set(portGroupMap.get(pk)!.map(nKey)));
  }
  for (let i = 0; i < sharedPortKeys.length; i++) {
    for (let j = i + 1; j < sharedPortKeys.length; j++) {
      const setA = pkNeighborSets.get(sharedPortKeys[i])!;
      for (const n of pkNeighborSets.get(sharedPortKeys[j])!) {
        if (setA.has(n)) { ufUnion(sharedPortKeys[i], sharedPortKeys[j]); break; }
      }
    }
  }

  // Group port keys by segment root
  const segGroups = new Map<string, string[]>();
  for (const pk of sharedPortKeys) {
    const root = ufFind(pk);
    if (!segGroups.has(root)) segGroups.set(root, []);
    segGroups.get(root)!.push(pk);
  }

  // Build synthetic segment nodes and their connections
  interface SegConn { src: string; dst: string; port: string; }
  const segNodes: ExternalTopologyNode[] = [];
  const segConns: SegConn[] = [];

  for (const [root, pks] of segGroups) {
    const segId = `seg-${root.replace(/[^a-z0-9]/gi, '')}`;

    const srcDevPorts = new Map<string, string>(); // devId → local port
    const allDevIds   = new Set<string>();
    const extNKeys    = new Set<string>();

    for (const pk of pks) {
      const colonIdx = pk.indexOf('::');
      const devId = pk.slice(0, colonIdx);
      const port  = pk.slice(colonIdx + 2);
      srcDevPorts.set(devId, port);
      allDevIds.add(devId);
      for (const link of portGroupMap.get(pk)!) {
        if (link.to_device_id) allDevIds.add(String(link.to_device_id));
        else extNKeys.add(nKey(link));
      }
    }

    segNodes.push({
      id: segId,
      name: 'Shared Segment',
      address: '',
      platform: `${allDevIds.size} managed devices`,
      mac: '',
      caps: 'segment', // sentinel for the ExternalNode renderer
    });

    // Connect each source device to the segment node
    for (const [devId, port] of srcDevPorts) {
      segConns.push({ src: devId, dst: segId, port });
    }
    // Connect unmanaged external neighbors to the segment node
    for (const nk of extNKeys) {
      const ext = externalNodes.find((e) =>
        `m:${(e.mac || '').toLowerCase()}` === nk ||
        `a:${e.address}` === nk ||
        `i:${e.name}` === nk
      );
      if (ext) segConns.push({ src: ext.id, dst: segId, port: '' });
    }
  }

  // Active direct links = LLDP + solo non-LLDP (single neighbor on that port)
  const activeLinks = [...lldpLinks, ...soloNonLldp];
  const allExtNodes = [...externalNodes, ...segNodes];

  // ── Adjacency ───────────────────────────────────────────────────────────────
  const adj = new Map<string, Set<string>>();
  for (const d of devices) adj.set(String(d.id), new Set());
  for (const e of allExtNodes) adj.set(e.id, new Set());

  const linkToExtId = new Map<number, string>();
  for (const link of activeLinks) {
    if (!link.from_device_id) continue;
    const src = String(link.from_device_id);
    let dst: string | null = null;
    if (link.to_device_id) {
      dst = String(link.to_device_id);
    } else {
      const ext = allExtNodes.find(
        (e) => (link.neighbor_address && e.address === link.neighbor_address) ||
               (link.neighbor_mac && e.mac === link.neighbor_mac) ||
               (!link.neighbor_address && !link.neighbor_mac && link.neighbor_identity && e.name === link.neighbor_identity)
      );
      if (ext) { dst = ext.id; linkToExtId.set(link.id, ext.id); }
    }
    if (dst && adj.has(src) && adj.has(dst)) {
      adj.get(src)!.add(dst); adj.get(dst)!.add(src);
    }
  }
  // Segment connections into adjacency
  for (const { src, dst } of segConns) {
    if (adj.has(src) && adj.has(dst)) {
      adj.get(src)!.add(dst); adj.get(dst)!.add(src);
    }
  }

  // ── Root selection ──────────────────────────────────────────────────────────
  const hasStp = links.some((l) => l.stp_role);
  const deviceIds = new Set(devices.map((d) => String(d.id)));

  // Pick the best root per connected component so forests lay out cleanly.
  function pickRoot(componentIds: string[]): string {
    const stpRoot = hasStp
      ? (() => {
          const haveRootPort = new Set(
            links.filter((l) => l.stp_role === 'root').map((l) => String(l.from_device_id))
          );
          return componentIds.find((id) => deviceIds.has(id) && !haveRootPort.has(id));
        })()
      : undefined;
    if (stpRoot) return stpRoot;

    const inThisComponent = new Set(componentIds);
    // Prefer managed devices with the most in-component neighbors.
    let best = componentIds[0];
    let bestScore = -1;
    for (const id of componentIds) {
      const neighborCount = [...(adj.get(id) || [])].filter((n) => inThisComponent.has(n)).length;
      const score = (deviceIds.has(id) ? 1000 : 0) + neighborCount;
      if (score > bestScore) {
        best = id;
        bestScore = score;
      }
    }
    return best;
  }

  // ── Connected components ────────────────────────────────────────────────────
  const allIds = [...devices.map((d) => String(d.id)), ...allExtNodes.map((e) => e.id)];
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const id of allIds) {
    if (visited.has(id)) continue;
    const stack = [id];
    const comp: string[] = [];
    while (stack.length) {
      const n = stack.pop()!;
      if (visited.has(n)) continue;
      visited.add(n);
      comp.push(n);
      for (const m of adj.get(n) || []) if (!visited.has(m)) stack.push(m);
    }
    components.push(comp);
  }
  // Biggest components first — nicer visual priority.
  components.sort((a, b) => b.length - a.length);

  // ── Tidy-tree layout per component (Reingold-Tilford style) ─────────────────
  // For each component we build a spanning tree via BFS from its root, then
  // assign x positions bottom-up using subtree widths. Siblings are ordered to
  // minimize edge crossings by placing each child near the barycenter of its
  // own children (a simple but effective heuristic for mostly-tree graphs).

  const positions = new Map<string, { x: number; y: number }>();
  const depthById = new Map<string, number>();

  let componentOffsetX = 0;
  let globalMaxDepth = 0;

  for (const comp of components) {
    if (!comp.length) continue;
    const compSet = new Set(comp);
    const rootId = pickRoot(comp);

    // BFS to build a spanning tree (depth + children) for this component.
    const depth = new Map<string, number>();
    const children = new Map<string, string[]>();
    const bfs = [rootId];
    depth.set(rootId, 0);
    children.set(rootId, []);
    while (bfs.length) {
      const curr = bfs.shift()!;
      for (const n of adj.get(curr) || []) {
        if (!compSet.has(n) || depth.has(n)) continue;
        depth.set(n, depth.get(curr)! + 1);
        children.set(n, []);
        children.get(curr)!.push(n);
        bfs.push(n);
      }
    }

    // Order children: devices first, then by in-component degree desc, then by
    // id for stability. This keeps higher-fanout subtrees centered.
    for (const kids of children.values()) {
      kids.sort((a, b) => {
        const da = deviceIds.has(a) ? 0 : 1;
        const db = deviceIds.has(b) ? 0 : 1;
        if (da !== db) return da - db;
        const ga = (adj.get(a)?.size || 0);
        const gb = (adj.get(b)?.size || 0);
        if (gb !== ga) return gb - ga;
        return a.localeCompare(b);
      });
    }

    // Post-order: compute subtree "slot width" then assign x.
    const slotWidth = new Map<string, number>();
    function computeWidth(id: string): number {
      const kids = children.get(id) || [];
      if (!kids.length) {
        slotWidth.set(id, 1);
        return 1;
      }
      let total = 0;
      for (const k of kids) total += computeWidth(k);
      slotWidth.set(id, Math.max(1, total));
      return slotWidth.get(id)!;
    }
    computeWidth(rootId);

    // Assign x: each node gets centered over the span of its children.
    function assign(id: string, leftSlot: number): void {
      const kids = children.get(id) || [];
      if (!kids.length) {
        positions.set(id, {
          x: componentOffsetX + (leftSlot + 0.5) * NODE_SLOT - NODE_W / 2,
          y: (depth.get(id) || 0) * (NODE_H + V_GAP),
        });
        return;
      }
      let cursor = leftSlot;
      for (const k of kids) {
        assign(k, cursor);
        cursor += slotWidth.get(k)!;
      }
      // Center parent over its children's span.
      const firstKid = positions.get(kids[0])!;
      const lastKid = positions.get(kids[kids.length - 1])!;
      positions.set(id, {
        x: (firstKid.x + lastKid.x) / 2,
        y: (depth.get(id) || 0) * (NODE_H + V_GAP),
      });
    }
    assign(rootId, 0);

    // Track overall depth and advance the X offset for the next component.
    let compMaxDepth = 0;
    for (const id of comp) {
      const d = depth.get(id);
      if (d !== undefined) depthById.set(id, d);
      compMaxDepth = Math.max(compMaxDepth, depth.get(id) || 0);
    }
    globalMaxDepth = Math.max(globalMaxDepth, compMaxDepth);

    const widthSlots = slotWidth.get(rootId) || 1;
    componentOffsetX += widthSlots * NODE_SLOT + COMPONENT_GAP;
  }

  // Center the whole layout horizontally around x=0 for a tidier fitView.
  if (positions.size) {
    const xs = [...positions.values()].map((p) => p.x);
    const centerShift = (Math.min(...xs) + Math.max(...xs)) / 2;
    for (const [id, p] of positions) {
      positions.set(id, { x: p.x - centerShift, y: p.y });
    }
  }

  // Optional strict row alignment; otherwise organic tree + overlap separation.
  if (layout.alignByDepth) {
    layoutAlignedRows(positions, depthById);
  } else {
    resolveOverlaps(positions);
  }

  // The STP root badge should only be shown for true STP roots, not just the
  // picked tree root of each component.
  const stpRootId = hasStp
    ? (() => {
        const haveRootPort = new Set(
          links.filter((l) => l.stp_role === 'root').map((l) => String(l.from_device_id))
        );
        return devices.map((d) => String(d.id)).find((id) => !haveRootPort.has(id)) ?? '';
      })()
    : '';

  // ── React Flow nodes ─────────────────────────────────────────────────────────
  const orphanY = (globalMaxDepth + 1) * (NODE_H + V_GAP);
  const nodes: Node[] = [
    ...devices.map((d) => ({
      id: String(d.id),
      type: 'deviceNode',
      position: positions.get(String(d.id)) || { x: 0, y: 0 },
      data: { ...d, isRootBridge: hasStp && String(d.id) === stpRootId } as unknown as Record<string, unknown>,
    })),
    ...allExtNodes.map((e) => ({
      id: e.id,
      type: 'externalNode',
      position: positions.get(e.id) || { x: 0, y: orphanY },
      data: e as unknown as Record<string, unknown>,
    })),
  ];

  // ── React Flow edges ─────────────────────────────────────────────────────────
  const seen = new Set<string>();
  const edges: Edge[] = [];

  // Direct links (LLDP + solo non-LLDP)
  for (const link of activeLinks) {
    if (!link.from_device_id) continue;
    const src = String(link.from_device_id);
    const dst = link.to_device_id ? String(link.to_device_id) : (linkToExtId.get(link.id) ?? null);
    if (!dst) continue;

    const edgeKey = [src, dst].sort().join('--');
    if (seen.has(edgeKey)) continue;
    seen.add(edgeKey);

    let stroke = '#94a3b8';
    let strokeDasharray: string | undefined;
    let animated = false;
    if (link.stp_role === 'root')      { stroke = '#3b82f6'; animated = true; }
    else if (link.stp_role === 'designated') { stroke = '#22c55e'; }
    else if (link.stp_role === 'alternate' || link.stp_role === 'backup') {
      stroke = '#ef4444'; strokeDasharray = '6,3';
    }

    const stpLabel  = link.stp_role ? ` [${link.stp_role}]` : '';
    const portLabel = link.from_interface
      ? (link.to_interface ? `${link.from_interface} ↔ ${link.to_interface}` : link.from_interface)
      : '';

    edges.push({
      id: `edge-${link.id}`,
      source: src,
      target: dst,
      label: (portLabel + stpLabel) || undefined,
      labelStyle: { fontSize: 10, fill: 'var(--topology-edge-label, #64748b)' },
      className: 'topology-edge',
      style: { stroke, strokeWidth: 2, strokeDasharray },
      animated,
    });
  }

  // Shared-segment connection edges
  for (const { src, dst, port } of segConns) {
    const edgeKey = [src, dst].sort().join('--');
    if (seen.has(edgeKey)) continue;
    seen.add(edgeKey);
    edges.push({
      id: `segedge-${src}-${dst}`,
      source: src,
      target: dst,
      label: port || undefined,
      labelStyle: { fontSize: 10, fill: 'var(--topology-seg-edge-label, #b45309)' },
      className: 'topology-edge topology-edge--segment',
      style: { stroke: '#f59e0b', strokeWidth: 2, strokeDasharray: '5,3' },
      animated: false,
    });
  }

  return { nodes, edges };
}

export default function TopologyPage() {
  const theme = useThemeStore((s) => s.theme);
  const [alignRows, setAlignRows] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['topology'],
    queryFn: () => topologyApi.get().then((r) => r.data),
  });

  const discoverMutation = useMutation({
    mutationFn: () => topologyApi.discover(),
    onSuccess: () => setTimeout(() => refetch(), 3000),
  });

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const graph = useMemo(() => {
    if (!data) return { nodes: [] as Node[], edges: [] as Edge[] };
    return buildGraph(
      (data.devices as TopologyDevice[]) || [],
      (data.externalNodes as ExternalTopologyNode[]) || [],
      (data.links as TopologyLink[]) || [],
      { alignByDepth: alignRows }
    );
  }, [data, alignRows]);

  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [graph, setNodes, setEdges]);

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges]
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96 text-gray-400">Loading topology...</div>
    );
  }

  const hasData = (data?.devices?.length ?? 0) > 0;
  const hasStp = (data?.links as TopologyLink[])?.some((l) => l.stp_role);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">Network Topology</h1>
        <div className="flex flex-wrap items-center gap-3 flex-shrink-0">
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              className="rounded border-gray-300 dark:border-slate-600"
              checked={alignRows}
              onChange={(e) => setAlignRows(e.target.checked)}
            />
            <span title="Place every node at the same tree depth on one horizontal row (strict grid). Off by default: organic tree layout with automatic spacing so labels and nodes do not overlap.">
              Align by depth (rows)
            </span>
          </label>
          <button
            onClick={() => discoverMutation.mutate()}
            disabled={discoverMutation.isPending}
            className="btn-secondary flex items-center gap-2"
          >
            <RefreshCw className={clsx('w-4 h-4', discoverMutation.isPending && 'animate-spin')} />
            Discover
          </button>
        </div>
      </div>

      {!hasData ? (
        <div className="card p-16 flex flex-col items-center gap-4 text-center">
          <GitBranch className="w-16 h-16 text-gray-300 dark:text-slate-600" />
          <div>
            <p className="font-medium text-gray-700 dark:text-slate-300">No topology data yet</p>
            <p className="text-sm text-gray-400 dark:text-slate-500 mt-1">
              Add devices and click &quot;Discover&quot; to map your network topology via LLDP neighbors.
            </p>
          </div>
          <button
            onClick={() => discoverMutation.mutate()}
            disabled={discoverMutation.isPending}
            className="btn-primary flex items-center gap-2"
          >
            <RefreshCw className={clsx('w-4 h-4', discoverMutation.isPending && 'animate-spin')} />
            Start Discovery
          </button>
        </div>
      ) : (
        <>
          <div className="card overflow-hidden" style={{ height: 'min(600px, 60vh)' }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.2, includeHiddenNodes: false }}
              minZoom={0.2}
              maxZoom={2}
              className={clsx(
                'topology-reactflow h-full min-h-[400px] bg-slate-50 dark:bg-slate-800',
                theme === 'dark' && 'dark'
              )}
            >
              <Controls className="topology-controls !shadow-md" />
              <MiniMap
                className="!shadow-md"
                nodeColor={(n) => {
                  if (n.type === 'externalNode') return '#94a3b8';
                  const d = n.data as unknown as TopologyDevice;
                  return statusColor[d.status] || '#94a3b8';
                }}
              />
              <Background variant={BackgroundVariant.Dots} color="#94a3b8" gap={20} />
            </ReactFlow>
          </div>

          {/* Legend */}
          <div className="card px-4 py-3 flex flex-wrap gap-4 text-xs text-gray-500 dark:text-slate-400">
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-0.5 bg-gray-400" />
              <span>Direct link (LLDP)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div style={{ width: 16, borderTop: '2px dashed #f59e0b' }} />
              <span>Shared segment (CDP/MNDP)</span>
            </div>
            {hasStp && (
              <>
                <div className="flex items-center gap-1.5">
                  <div className="w-4 h-0.5 bg-blue-500" />
                  <span>Root port (uplink)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-4 h-0.5 bg-green-500" />
                  <span>Designated (active)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div style={{ width: 16, borderTop: '2px dashed #ef4444' }} />
                  <span>Alternate/Backup (blocked)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-amber-500 font-bold">★</span>
                  <span>Root Bridge</span>
                </div>
              </>
            )}
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-4 rounded border-dashed border border-gray-400" />
              <span>External (unmanaged)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-4 rounded border-dashed border-amber-400" />
              <span>Shared segment node</span>
            </div>
          </div>
        </>
      )}

      {/* Link table */}
      {(data?.links?.length ?? 0) > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              Discovered Links ({(data!.links as TopologyLink[]).length})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-slate-700">
                  <th className="table-header px-4 py-2.5 text-left">From Device</th>
                  <th className="table-header px-4 py-2.5 text-left">Local Port</th>
                  <th className="table-header px-4 py-2.5 text-left">Remote Port</th>
                  <th className="table-header px-4 py-2.5 text-left">Neighbor</th>
                  <th className="table-header px-4 py-2.5 text-left">Neighbor IP</th>
                  <th className="table-header px-4 py-2.5 text-left">Protocol</th>
                  <th className="table-header px-4 py-2.5 text-left">STP Role</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                {(data!.links as TopologyLink[]).map((link) => (
                  <tr key={link.id} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                    <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">
                      {link.from_device_name || '—'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-slate-400">
                      {link.from_interface || '—'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-slate-400">
                      {link.to_interface || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 dark:text-slate-300">
                      {link.to_device_name || link.neighbor_identity || '—'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-slate-400">
                      {link.neighbor_address || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      {link.link_type ? (
                        <span className={clsx(
                          'px-1.5 py-0.5 rounded font-medium uppercase',
                          link.link_type === 'lldp' && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
                          link.link_type === 'cdp'  && 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
                          link.link_type === 'mndp' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
                          !['lldp','cdp','mndp'].includes(link.link_type) && 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300',
                        )}>
                          {link.link_type}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      {link.stp_role ? (
                        <span className={clsx(
                          'px-1.5 py-0.5 rounded font-medium',
                          link.stp_role === 'root' && 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
                          link.stp_role === 'designated' && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
                          (link.stp_role === 'alternate' || link.stp_role === 'backup') && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
                        )}>
                          {link.stp_role}
                        </span>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
