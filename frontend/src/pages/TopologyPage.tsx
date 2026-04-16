import { useCallback, useEffect } from 'react';
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

const NODE_W = 160;
const NODE_H = 80;
const H_GAP = 60;
const V_GAP = 90;

function buildGraph(
  devices: TopologyDevice[],
  externalNodes: ExternalTopologyNode[],
  links: TopologyLink[]
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

  // IDs of all links absorbed into segments (not rendered as direct edges)
  const absorbedIds = new Set<number>(
    sharedPortKeys.flatMap((pk) => portGroupMap.get(pk)!.map((l) => l.id))
  );

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

  // ── Root / BFS levels ───────────────────────────────────────────────────────
  const hasStp = links.some((l) => l.stp_role);
  let rootId: string;
  if (hasStp) {
    const devicesWithRootPort = new Set(
      links.filter((l) => l.stp_role === 'root').map((l) => String(l.from_device_id))
    );
    const rootDevice = devices.find((d) => !devicesWithRootPort.has(String(d.id)));
    rootId = rootDevice ? String(rootDevice.id) : devices[0] ? String(devices[0].id) : '';
  } else {
    rootId = devices.reduce((best, d) =>
      (adj.get(String(d.id))?.size || 0) > (adj.get(best)?.size || 0) ? String(d.id) : best,
      devices[0] ? String(devices[0].id) : ''
    );
  }

  const levels = new Map<string, number>();
  if (rootId) {
    const queue: string[] = [rootId];
    levels.set(rootId, 0);
    while (queue.length) {
      const curr = queue.shift()!;
      for (const neighbor of adj.get(curr) || []) {
        if (!levels.has(neighbor)) {
          levels.set(neighbor, levels.get(curr)! + 1);
          queue.push(neighbor);
        }
      }
    }
  }

  const maxLevel = levels.size > 0 ? Math.max(...levels.values()) : 0;
  const allIds = [...devices.map((d) => String(d.id)), ...allExtNodes.map((e) => e.id)];
  for (const id of allIds) if (!levels.has(id)) levels.set(id, maxLevel + 1);

  // ── Positioning ─────────────────────────────────────────────────────────────
  const byLevel = new Map<number, string[]>();
  for (const [id, lvl] of levels) {
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl)!.push(id);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [lvl, ids] of byLevel) {
    const rowW = ids.length * NODE_W + (ids.length - 1) * H_GAP;
    ids.forEach((id, i) => {
      positions.set(id, { x: -rowW / 2 + i * (NODE_W + H_GAP), y: lvl * (NODE_H + V_GAP) });
    });
  }

  // ── React Flow nodes ─────────────────────────────────────────────────────────
  const nodes: Node[] = [
    ...devices.map((d) => ({
      id: String(d.id),
      type: 'deviceNode',
      position: positions.get(String(d.id)) || { x: 0, y: 0 },
      data: { ...d, isRootBridge: String(d.id) === rootId && hasStp } as unknown as Record<string, unknown>,
    })),
    ...allExtNodes.map((e) => ({
      id: e.id,
      type: 'externalNode',
      position: positions.get(e.id) || { x: 0, y: (maxLevel + 1) * (NODE_H + V_GAP) },
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
      labelStyle: { fontSize: 9, fill: '#94a3b8' },
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
      labelStyle: { fontSize: 9, fill: '#b45309' },
      style: { stroke: '#f59e0b', strokeWidth: 2, strokeDasharray: '5,3' },
      animated: false,
    });
  }

  return { nodes, edges };
}

export default function TopologyPage() {
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

  useEffect(() => {
    if (!data) return;
    const { nodes: n, edges: e } = buildGraph(
      (data.devices as TopologyDevice[]) || [],
      (data.externalNodes as ExternalTopologyNode[]) || [],
      (data.links as TopologyLink[]) || []
    );
    setNodes(n);
    setEdges(e);
  }, [data, setNodes, setEdges]);

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
        <div className="flex gap-2 flex-shrink-0">
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
          <div className="card" style={{ height: 'min(600px, 60vh)' }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              fitView
              minZoom={0.2}
              maxZoom={2}
              className="dark:bg-slate-800"
            >
              <Controls className="dark:bg-slate-700 dark:text-white" />
              <MiniMap
                className="dark:bg-slate-700"
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
