import { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { Router, Users, AlertTriangle, Wifi, Activity, TrendingUp, MapPin, ArrowUpCircle, X, Signal } from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { metricsApi, eventsApi, devicesApi, clientsApi } from '../services/api';
import { useSocket } from '../hooks/useSocket';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import type { Device, DeviceEvent } from '../types';
import clsx from 'clsx';

const ALL_SEVERITIES = ['error', 'warning', 'info'] as const;

// ─── Device Locations Map ────────────────────────────────────────────────────

function DeviceLocationsMap({ devices }: { devices: Device[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  const mapped = useMemo(() => devices.filter(
    (d) => d.location_lat != null && d.location_lng != null &&
      !isNaN(Number(d.location_lat)) && !isNaN(Number(d.location_lng))
  ), [devices]);

  useEffect(() => {
    if (!containerRef.current || mapped.length === 0) return;

    const map = L.map(containerRef.current, { scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    // Group devices by exact lat/lng so co-located devices share one marker
    const groups = new Map<string, Device[]>();
    for (const d of mapped) {
      const key = `${Number(d.location_lat).toFixed(6)},${Number(d.location_lng).toFixed(6)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(d);
    }

    const markers: L.Layer[] = [];

    groups.forEach((groupDevices) => {
      const lat = Number(groupDevices[0].location_lat);
      const lng = Number(groupDevices[0].location_lng);
      const count = groupDevices.length;

      // Worst-status color: offline > unknown > online
      const hasOffline = groupDevices.some((d) => d.status === 'offline');
      const hasUnknown = groupDevices.some((d) => d.status !== 'online' && d.status !== 'offline');
      const color = hasOffline ? '#ef4444' : hasUnknown ? '#94a3b8' : '#10b981';

      // Popup: list every device with its status
      const address = groupDevices[0].location_address
        ? `<br/><span style="color:#64748b;font-size:11px">${groupDevices[0].location_address}</span>`
        : '';
      const deviceRows = groupDevices
        .map((d) => {
          const c = d.status === 'online' ? '#10b981' : d.status === 'offline' ? '#ef4444' : '#94a3b8';
          return `<b>${d.name}</b>&nbsp;<span style="color:${c};font-size:11px;font-weight:600">● ${d.status}</span>`;
        })
        .join('<br/>');
      const popupHtml = `${deviceRows}${address}`;

      // Tooltip on hover: quick device list with emoji indicators
      const tooltipHtml = groupDevices
        .map((d) => {
          const dot = d.status === 'online' ? '🟢' : d.status === 'offline' ? '🔴' : '⚪';
          return `${dot} ${d.name}`;
        })
        .join('<br/>');

      let marker: L.Layer;
      if (count === 1) {
        marker = L.circleMarker([lat, lng], {
          radius: 9,
          color: '#fff',
          weight: 2,
          fillColor: color,
          fillOpacity: 0.9,
        })
          .bindPopup(popupHtml)
          .bindTooltip(tooltipHtml, { direction: 'top', offset: [0, -10] });
      } else {
        const size = count > 9 ? 32 : 28;
        const half = size / 2;
        const icon = L.divIcon({
          className: '',
          html: `<div style="background:${color};color:#fff;border:2px solid #fff;border-radius:50%;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,0.35);cursor:pointer">${count}</div>`,
          iconSize: [size, size],
          iconAnchor: [half, half],
          popupAnchor: [0, -half],
          tooltipAnchor: [0, -half],
        });
        marker = L.marker([lat, lng], { icon })
          .bindPopup(popupHtml)
          .bindTooltip(tooltipHtml, { direction: 'top' });
      }

      marker.addTo(map);
      markers.push(marker);
    });

    if (markers.length === 1) {
      const first = mapped[0];
      map.setView([Number(first.location_lat), Number(first.location_lng)], 13);
    } else {
      map.fitBounds(L.featureGroup(markers).getBounds(), { padding: [40, 40] });
    }

    return () => { map.remove(); };
  }, [mapped]);

  if (mapped.length === 0) {
    return (
      <div className="h-[300px] flex items-center justify-center text-gray-400 dark:text-slate-500 text-sm text-center px-4">
        No device locations configured — add addresses via Device › Overview › Physical Details
      </div>
    );
  }

  return <div ref={containerRef} style={{ height: 300, width: '100%', borderRadius: 8 }} />;
}

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color = 'blue',
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
  onClick?: () => void;
}) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
    green: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400',
    red: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
    yellow: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400',
  };

  return (
    <div
      className={clsx('card p-5', onClick && 'cursor-pointer hover:shadow-md transition-shadow')}
      onClick={onClick}
    >
      <div className="flex items-center gap-4">
        <div className={clsx('p-3 rounded-xl', colors[color])}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
          <div className="text-sm text-gray-500 dark:text-slate-400">{label}</div>
          {sub && <div className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">{sub}</div>}
        </div>
      </div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const classes: Record<string, string> = {
    error: 'severity-error',
    critical: 'severity-error',
    warning: 'severity-warning',
    info: 'severity-info',
  };
  return (
    <span className={clsx('px-2 py-0.5 rounded text-xs font-medium', classes[severity] || classes.info)}>
      {severity}
    </span>
  );
}

const SEVERITY_KEY = 'dashboard:severities';

function loadSeverities(): Set<string> {
  try {
    const saved = localStorage.getItem(SEVERITY_KEY);
    if (saved) return new Set(JSON.parse(saved));
  } catch { /* ignore */ }
  return new Set(ALL_SEVERITIES);
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [severities, setSeverities] = useState<Set<string>>(loadSeverities);

  const toggleSeverity = (s: string) =>
    setSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      localStorage.setItem(SEVERITY_KEY, JSON.stringify([...next]));
      return next;
    });

  const severityParam =
    severities.size === 0 || severities.size === ALL_SEVERITIES.length
      ? undefined
      : [...severities].join(',');

  const { data: summary } = useQuery({
    queryKey: ['metrics-summary'],
    queryFn: () => metricsApi.summary().then((r) => r.data),
    refetchInterval: 30_000,
  });

  const { data: clientsOverTimeRaw = [] } = useQuery({
    queryKey: ['clients-over-time', '24h'],
    queryFn: () => metricsApi.clientsOverTime('24h').then((r) => r.data),
    refetchInterval: 60_000,
  });
  // Convert ISO timestamps to numeric ms for a proper continuous time axis
  const clientsOverTime = clientsOverTimeRaw.map((p) => ({
    ...p,
    ts: new Date(p.time).getTime(),
  }));

  const chartDomain = useMemo<[number, number]>(
    () => [Date.now() - 24 * 60 * 60 * 1000, Date.now()],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clientsOverTime]
  );

  const { data: topClients = [] } = useQuery({
    queryKey: ['top-clients'],
    queryFn: () => metricsApi.topClients(8).then((r) => r.data),
    refetchInterval: 60_000,
  });

  const { data: wirelessClientsData } = useQuery({
    queryKey: ['wireless-clients-active'],
    queryFn: () => clientsApi.list({ active: true, client_type: 'wireless', limit: 1 }).then((r) => r.data),
    refetchInterval: 30_000,
  });

  const { data: eventsData } = useQuery({
    queryKey: ['events-recent', severityParam],
    queryFn: () => eventsApi.list({ limit: 5, severity: severityParam }).then((r) => r.data),
    refetchInterval: 30_000,
  });

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then((r) => r.data),
    refetchInterval: 30_000,
  });

  useSocket({
    'device:updated': () => {
      queryClient.invalidateQueries({ queryKey: ['metrics-summary'] });
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    'clients:updated': () => {
      queryClient.invalidateQueries({ queryKey: ['top-clients'] });
      queryClient.invalidateQueries({ queryKey: ['metrics-summary'] });
      queryClient.invalidateQueries({ queryKey: ['wireless-clients-active'] });
    },
    'events:updated': () => queryClient.invalidateQueries({ queryKey: ['events-recent'] }),
    'device:status': () => queryClient.invalidateQueries({ queryKey: ['metrics-summary'] }),
  });

  const [dismissedFirmwareIds, setDismissedFirmwareIds] = useState<number[]>([]);
  const devicesWithUpdates = devices.filter(
    (d) => d.firmware_update_available && !dismissedFirmwareIds.includes(d.id)
  );

  // Device type distribution for pie chart
  const deviceTypeLabel: Record<string, string> = {
    router: 'Router', switch: 'Switch', wireless_ap: 'Wireless AP', other: 'Other',
  };
  const deviceTypes = devices.reduce((acc: Record<string, number>, d) => {
    const type = d.device_type || 'other';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  const pieData = Object.entries(deviceTypes).map(([key, value]) => ({ name: deviceTypeLabel[key] ?? key, value }));

  const formatBytes = (bytes: number) => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
    return `${bytes} B`;
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-gray-900 dark:text-white">Dashboard</h1>

      {/* Firmware update banner */}
      {devicesWithUpdates.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-700/50 dark:bg-amber-900/20 px-4 py-3 flex items-start gap-3">
          <ArrowUpCircle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
          <div className="flex-1 text-sm text-amber-800 dark:text-amber-300">
            <span className="font-semibold">Firmware update{devicesWithUpdates.length > 1 ? 's' : ''} available</span>
            {' — '}
            {devicesWithUpdates.map((d, i) => (
              <span key={d.id}>
                {i > 0 && ', '}
                <button
                  onClick={() => navigate(`/devices/${d.id}`)}
                  className="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200 font-medium"
                >
                  {d.name}
                  {d.latest_ros_version && (
                    <span className="font-normal"> ({d.latest_ros_version})</span>
                  )}
                </button>
              </span>
            ))}
          </div>
          <button
            onClick={() => setDismissedFirmwareIds((ids) => [...ids, ...devicesWithUpdates.map((d) => d.id)])}
            className="p-0.5 rounded hover:bg-amber-200 dark:hover:bg-amber-800/50 text-amber-500 flex-shrink-0"
            title="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard
          icon={Router}
          label="Total Devices"
          value={summary?.devices.total ?? '—'}
          sub={`${summary?.devices.online ?? 0} online, ${summary?.devices.offline ?? 0} offline`}
          color="blue"
          onClick={() => navigate('/devices')}
        />
        <StatCard
          icon={Wifi}
          label="Active Clients"
          value={summary?.clients.active ?? '—'}
          sub={`${summary?.clients.total ?? 0} total known`}
          color="green"
          onClick={() => navigate('/clients')}
        />
        <StatCard
          icon={Signal}
          label="Wireless Clients"
          value={wirelessClientsData?.total ?? '—'}
          color="blue"
          onClick={() => navigate('/wireless/clients')}
        />
        <StatCard
          icon={AlertTriangle}
          label="Alerts (24h)"
          value={summary?.alerts.critical ?? '—'}
          sub={`${summary?.alerts.warning ?? 0} warnings`}
          color={summary?.alerts.critical ? 'red' : 'yellow'}
          onClick={() => navigate('/events')}
        />
        <StatCard
          icon={Activity}
          label="Devices Online"
          value={summary?.devices.online ?? '—'}
          sub={`of ${summary?.devices.total ?? 0} total`}
          color="green"
        />
        <StatCard
          icon={Activity}
          label="Devices Offline"
          value={summary?.devices.offline ?? '—'}
          sub={`of ${summary?.devices.total ?? 0} total`}
          color={summary?.devices.offline ? 'red' : 'green'}
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Clients over time */}
        <div className="card p-5 lg:col-span-2">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp className="w-4 h-4 text-blue-500" />
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
              Connected Clients (24h)
            </h2>
          </div>
          {clientsOverTime.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={clientsOverTime} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                <XAxis
                  dataKey="ts"
                  type="number"
                  scale="time"
                  domain={chartDomain}
                  tick={{ fontSize: 11 }}
                  tickCount={7}
                  tickFormatter={(t) => format(new Date(t), 'HH:mm')}
                />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  formatter={(v: number) => [v, 'Clients']}
                  labelFormatter={(t) => format(new Date(t as number), 'MMM d, HH:mm')}
                  contentStyle={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-gray-400 dark:text-slate-500 text-sm">
              No data yet — metrics will appear after devices are polled
            </div>
          )}
        </div>

        {/* Device type pie */}
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Router className="w-4 h-4 text-blue-500" />
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Device Types</h2>
          </div>
          {pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={3}
                  dataKey="value"
                >
                  {pieData.map((_entry, index) => (
                    <Cell key={index} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Legend formatter={(v) => <span className="text-xs capitalize">{v}</span>} />
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-gray-400 dark:text-slate-500 text-sm">
              No devices added yet
            </div>
          )}
        </div>
      </div>

      {/* Device locations map */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-blue-500" />
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Device Locations</h2>
          </div>
          <span className="text-xs text-gray-400 dark:text-slate-500">
            {devices.filter((d) => d.location_lat != null && d.location_lng != null).length} of {devices.length} devices mapped
          </span>
        </div>
        <DeviceLocationsMap devices={devices} />
      </div>

      {/* Bottom row: Top clients + Recent events */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top clients */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-blue-500" />
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Top Clients</h2>
            </div>
            <button
              onClick={() => navigate('/clients')}
              className="text-xs text-blue-500 hover:text-blue-600"
            >
              View all
            </button>
          </div>
          {topClients.length > 0 ? (() => {
            const top5 = topClients.slice(0, 5);
            const maxBytes = top5[0]?.total_bytes ?? 1;
            const barColors = ['#3b82f6', '#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd'];
            return (
              <div className="space-y-2.5">
                {top5.map((client, i) => {
                  const pct = Math.max(4, (client.total_bytes / maxBytes) * 100);
                  const label = client.hostname || client.mac_address || 'Unknown';
                  return (
                    <div
                      key={client.mac_address}
                      className="flex items-center gap-2 cursor-pointer group"
                      onClick={() => navigate(`/clients/${encodeURIComponent(client.mac_address)}`)}
                    >
                      <span className="text-xs text-gray-400 dark:text-slate-500 w-3 flex-shrink-0 text-right">
                        {i + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 mb-0.5">
                          <span className="text-xs font-medium text-gray-700 dark:text-slate-300 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                            {label.length > 22 ? label.slice(0, 22) + '…' : label}
                          </span>
                          <span className="text-xs text-gray-500 dark:text-slate-400 flex-shrink-0 font-mono">
                            {formatBytes(client.total_bytes)}
                          </span>
                        </div>
                        <div className="h-1.5 w-full bg-gray-100 dark:bg-slate-700 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${pct}%`, backgroundColor: barColors[i] }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })() : (
            <div className="h-[120px] flex items-center justify-center text-gray-400 dark:text-slate-500 text-sm">
              No active clients
            </div>
          )}
        </div>

        {/* Recent events */}
        <div className="card p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-blue-500" />
              <button
                onClick={() => navigate('/events')}
                className="text-sm font-semibold text-gray-900 dark:text-white hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
              >
                Recent Events
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              {([
                { key: 'error', label: 'Error', color: 'text-red-500' },
                { key: 'warning', label: 'Warning', color: 'text-yellow-500' },
                { key: 'info', label: 'Info', color: 'text-blue-500' },
              ] as const).map(({ key, label, color }) => (
                <label key={key} className="flex items-center gap-1 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={severities.has(key)}
                    onChange={() => toggleSeverity(key)}
                    className="w-3 h-3 rounded cursor-pointer"
                  />
                  <span className={clsx('text-xs font-medium', color)}>{label}</span>
                </label>
              ))}
              <button
                onClick={() => navigate('/events')}
                className="text-xs text-blue-500 hover:text-blue-600"
              >
                View all
              </button>
            </div>
          </div>
          <div className="space-y-1">
            {(eventsData?.events ?? []).length > 0 ? (
              eventsData!.events.map((ev: DeviceEvent) => (
                <div
                  key={ev.id}
                  className="flex items-start gap-3 py-1.5 border-b border-gray-100 dark:border-slate-700 last:border-0"
                >
                  <SeverityBadge severity={ev.severity} />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-gray-700 dark:text-slate-300 truncate">
                      {ev.message}
                    </p>
                    <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">
                      {ev.device_name} · {format(new Date(ev.event_time), 'MMM d, HH:mm')}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <div className="flex items-center justify-center h-[120px] text-gray-400 dark:text-slate-500 text-sm">
                No recent events
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
