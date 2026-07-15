import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, AlertCircle, CheckCircle, Timer } from 'lucide-react';
import { devicesApi } from '../../services/api';
import type { PollingClass, PollingConfig } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';
import clsx from 'clsx';

interface Props {
  deviceId: number;
}

type Mode = 'default' | 'interval' | 'cron';

interface RowState {
  enabled: boolean;
  mode: Mode;
  seconds: string;
  cron: string;
}

const POLL_CLASSES: { key: PollingClass; label: string; description: string; defaultSeconds: number }[] = [
  { key: 'fast', label: 'Fast metrics', description: 'Interface stats, resource usage — 30s default', defaultSeconds: 30 },
  { key: 'slow', label: 'Slow inventory', description: 'Config, VLANs, routes — 5min default', defaultSeconds: 300 },
  { key: 'logs', label: 'Device logs', description: 'System/event log polling — 60s default', defaultSeconds: 60 },
  { key: 'macscan', label: 'MAC scan', description: 'Maps MAC addresses to IPs via /tool/mac-scan', defaultSeconds: 300 },
  { key: 'spectral', label: 'Spectral scan', description: 'Wireless spectral history scan', defaultSeconds: 300 },
  { key: 'apscan', label: 'AP scan', description: 'Wireless AP/neighbor scan', defaultSeconds: 86400 },
  { key: 'configsnap', label: 'Config snapshot', description: 'Periodic exported config snapshot for history/diff', defaultSeconds: 3600 },
  { key: 'scripts', label: 'Scripts inventory', description: 'Inventory of /system script + /system scheduler entries — 6h default', defaultSeconds: 21600 },
];

function emptyRow(defaultSeconds: number): RowState {
  return { enabled: true, mode: 'default', seconds: String(defaultSeconds), cron: '' };
}

function rowsFromConfig(config: PollingConfig): Record<PollingClass, RowState> {
  const rows = {} as Record<PollingClass, RowState>;
  for (const { key, defaultSeconds } of POLL_CLASSES) {
    const entry = config[key];
    if (!entry) {
      rows[key] = emptyRow(defaultSeconds);
      continue;
    }
    rows[key] = {
      enabled: entry.enabled !== false,
      mode: entry.mode ?? 'default',
      seconds: entry.seconds !== undefined ? String(entry.seconds) : String(defaultSeconds),
      cron: entry.cron ?? '',
    };
  }
  return rows;
}

// Only send entries that actually diverge from "use the global default,
// enabled": a row left on Default with enabled=true is omitted entirely.
function rowsToPayload(rows: Record<PollingClass, RowState>): PollingConfig {
  const payload: PollingConfig = {};
  for (const { key } of POLL_CLASSES) {
    const row = rows[key];
    if (row.mode === 'default' && row.enabled) continue;

    if (row.mode === 'default') {
      payload[key] = { enabled: false };
      continue;
    }

    if (row.mode === 'interval') {
      payload[key] = {
        mode: 'interval',
        seconds: parseInt(row.seconds, 10),
        ...(row.enabled ? {} : { enabled: false }),
      };
    } else {
      payload[key] = {
        mode: 'cron',
        cron: row.cron.trim(),
        ...(row.enabled ? {} : { enabled: false }),
      };
    }
  }
  return payload;
}

function errMsg(err: unknown): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to save polling configuration';
}

export default function PollingTab({ deviceId }: Props) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();

  const { data, isLoading } = useQuery({
    queryKey: ['polling-config', deviceId],
    queryFn: () => devicesApi.getPollingConfig(deviceId).then((r) => r.data.polling_config),
  });

  const [rows, setRows] = useState<Record<PollingClass, RowState> | null>(null);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState('');

  useEffect(() => {
    if (data) setRows(rowsFromConfig(data));
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (payload: PollingConfig) => devicesApi.updatePollingConfig(deviceId, payload),
    onSuccess: (res) => {
      setRows(rowsFromConfig(res.data.polling_config));
      qc.invalidateQueries({ queryKey: ['polling-config', deviceId] });
      setSaveError('');
      setSaveSuccess('Polling configuration saved');
      setTimeout(() => setSaveSuccess(''), 3000);
    },
    onError: (err: unknown) => {
      setSaveError(errMsg(err));
      setSaveSuccess('');
    },
  });

  const setRow = (key: PollingClass, patch: Partial<RowState>) => {
    setRows((prev) => (prev ? { ...prev, [key]: { ...prev[key], ...patch } } : prev));
  };

  const handleSave = () => {
    if (!rows) return;
    setSaveError('');

    // Client-side validation mirrors the backend rules so the user gets
    // immediate, per-class feedback instead of a round-trip 400.
    for (const { key, label } of POLL_CLASSES) {
      const row = rows[key];
      if (row.mode === 'interval') {
        const secs = parseInt(row.seconds, 10);
        if (!Number.isInteger(secs) || secs < 10) {
          setSaveError(`${label}: interval seconds must be an integer >= 10`);
          return;
        }
      } else if (row.mode === 'cron' && row.cron.trim() === '') {
        setSaveError(`${label}: cron expression is required`);
        return;
      }
    }

    saveMutation.mutate(rowsToPayload(rows));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-blue-50 dark:bg-blue-900/20 rounded-lg flex items-center justify-center">
            <Timer className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
          </div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Polling Configuration</h3>
        </div>
        {canWrite && (
          <button
            onClick={handleSave}
            disabled={!rows || saveMutation.isPending}
            className="btn-primary flex items-center gap-2 text-xs py-1.5"
          >
            {saveMutation.isPending && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            Save
          </button>
        )}
      </div>
      <p className="text-xs text-gray-400">
        Overrides the global polling schedule (Settings → Polling Intervals) for this device only.
        Leave a class on <span className="font-medium">Default</span> to inherit the global interval.
      </p>

      {isLoading || !rows ? (
        <div className="text-center py-8 text-gray-400">
          <RefreshCw className="w-4 h-4 animate-spin inline mr-2" />
          Loading…
        </div>
      ) : (
        <div className="card overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50">
                <th className="table-header px-3 py-2.5 text-left">Class</th>
                <th className="table-header px-3 py-2.5 text-center">Enabled</th>
                <th className="table-header px-3 py-2.5 text-left">Mode</th>
                <th className="table-header px-3 py-2.5 text-left">Schedule</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
              {POLL_CLASSES.map(({ key, label, description }) => {
                const row = rows[key];
                return (
                  <tr key={key} className={clsx('hover:bg-gray-50 dark:hover:bg-slate-700/30', !row.enabled && 'opacity-50')}>
                    <td className="px-3 py-2.5 align-top">
                      <div className="text-xs font-medium text-gray-900 dark:text-white">{label}</div>
                      <div className="text-xs text-gray-400 mt-0.5">{description}</div>
                    </td>
                    <td className="px-3 py-2.5 align-top text-center">
                      <button
                        onClick={() => canWrite && setRow(key, { enabled: !row.enabled })}
                        disabled={!canWrite}
                        className={clsx(
                          'relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200',
                          canWrite ? 'cursor-pointer' : 'cursor-not-allowed',
                          row.enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600'
                        )}
                      >
                        <span
                          className={clsx(
                            'inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200',
                            row.enabled ? 'translate-x-4' : 'translate-x-0'
                          )}
                        />
                      </button>
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <select
                        className="input text-xs py-1"
                        value={row.mode}
                        onChange={(e) => setRow(key, { mode: e.target.value as Mode })}
                        disabled={!canWrite}
                      >
                        <option value="default">Default</option>
                        <option value="interval">Interval</option>
                        <option value="cron">Cron</option>
                      </select>
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      {row.mode === 'interval' && (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            min={10}
                            step={1}
                            className="input text-xs py-1 w-24 font-mono"
                            value={row.seconds}
                            onChange={(e) => setRow(key, { seconds: e.target.value })}
                            disabled={!canWrite}
                          />
                          <span className="text-xs text-gray-400">sec (min 10)</span>
                        </div>
                      )}
                      {row.mode === 'cron' && (
                        <div>
                          <input
                            type="text"
                            className="input text-xs py-1 w-40 font-mono"
                            placeholder="*/15 * * * *"
                            value={row.cron}
                            onChange={(e) => setRow(key, { cron: e.target.value })}
                            disabled={!canWrite}
                          />
                          <p className="text-xs text-gray-400 mt-1">min hour day month weekday</p>
                        </div>
                      )}
                      {row.mode === 'default' && (
                        <span className="text-xs text-gray-400">Uses global default interval</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {saveError && (
        <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
        </div>
      )}
      {saveSuccess && (
        <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
          <CheckCircle className="w-4 h-4" /> {saveSuccess}
        </div>
      )}
    </div>
  );
}
