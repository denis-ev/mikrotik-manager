import { Fragment, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileCode, ScrollText, RefreshCw, Loader2, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';
import clsx from 'clsx';
import { scriptsApi } from '../../services/api';
import type { DeviceScriptRow, ScriptKind, ScriptSyncStatus } from '../../services/api';
import { useCanWrite } from '../../hooks/useCanWrite';
import { useSocket } from '../../hooks/useSocket';
import { lineDiff } from '../../utils/lineDiff';

const SYNC_META: Record<ScriptSyncStatus, { label: string; cls: string }> = {
  in_sync:     { label: 'In sync',    cls: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' },
  drifted:     { label: 'Drifted',    cls: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400' },
  stale:       { label: 'Stale',      cls: 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400' },
  push_failed: { label: 'Push failed', cls: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400' },
  unlinked:    { label: 'Unlinked',   cls: 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400' },
};

function SyncPill({ status }: { status: ScriptSyncStatus }) {
  const meta = SYNC_META[status] ?? SYNC_META.unlinked;
  return <span className={clsx('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium', meta.cls)}>{meta.label}</span>;
}

function KindBadge({ kind }: { kind: ScriptKind }) {
  return (
    <span className={clsx(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0',
      kind === 'scheduler'
        ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400'
        : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
    )}>
      {kind === 'scheduler' ? <ScrollText className="w-3 h-3" /> : <FileCode className="w-3 h-3" />}
      {kind === 'scheduler' ? 'Scheduler' : 'Script'}
    </span>
  );
}

function DiffView({ deviceSource, managedSource }: { deviceSource: string; managedSource: string }) {
  const rows = lineDiff(managedSource, deviceSource);
  const addCount = rows.filter((r) => r.type === 'add').length;
  const delCount = rows.filter((r) => r.type === 'del').length;
  return (
    <div className="px-4 pb-3">
      <div className="text-xs text-gray-400 dark:text-slate-500 mb-1.5">
        Managed → Device diff — <span className="text-green-600 dark:text-green-400">+{addCount}</span>{' '}
        <span className="text-red-600 dark:text-red-400">−{delCount}</span>
      </div>
      <pre className="text-xs font-mono bg-gray-50 dark:bg-slate-900/60 border border-gray-200 dark:border-slate-700 rounded-lg p-3 overflow-auto max-h-80 leading-relaxed">
        {rows.map((row, idx) => (
          <div
            key={idx}
            className={clsx(
              'whitespace-pre-wrap',
              row.type === 'add' && 'bg-green-100/70 dark:bg-green-900/30 text-green-800 dark:text-green-300',
              row.type === 'del' && 'bg-red-100/70 dark:bg-red-900/30 text-red-800 dark:text-red-300',
              row.type === 'ctx' && 'text-gray-500 dark:text-slate-500'
            )}
          >
            {row.type === 'add' ? '+ ' : row.type === 'del' ? '- ' : '  '}
            {row.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

export default function ScriptsTab({ deviceId }: { deviceId: number }) {
  const canWrite = useCanWrite();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const { data: scripts = [], isLoading } = useQuery({
    queryKey: ['device-scripts', deviceId],
    queryFn: () => scriptsApi.getForDevice(deviceId).then((r) => r.data.scripts),
    refetchInterval: 60_000,
  });

  // Managed sources are needed to render the diff for drifted rows — shares
  // the ['scripts'] cache with ScriptsPage so visiting there first is free.
  const { data: overview } = useQuery({
    queryKey: ['scripts'],
    queryFn: () => scriptsApi.list().then((r) => r.data),
    staleTime: 30_000,
  });

  useSocket({
    'scripts:updated': () => {
      qc.invalidateQueries({ queryKey: ['device-scripts', deviceId] });
      qc.invalidateQueries({ queryKey: ['scripts'] });
    },
  });

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleRefresh() {
    setRefreshing(true);
    setError('');
    try {
      await scriptsApi.refreshDevice(deviceId);
      qc.invalidateQueries({ queryKey: ['device-scripts', deviceId] });
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  function managedSourceFor(row: DeviceScriptRow): string | null {
    if (!row.managed_script_id || !overview) return null;
    return overview.managed.find((m) => m.id === row.managed_script_id)?.source ?? null;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <FileCode className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Scripts &amp; Schedulers</h2>
        </div>
        {canWrite && (
          <button onClick={handleRefresh} disabled={refreshing} className="btn-secondary flex items-center gap-2 text-sm">
            {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Refresh from device
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-gray-400">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : scripts.length === 0 ? (
        <div className="card p-12 flex flex-col items-center gap-3 text-center">
          <FileCode className="w-14 h-14 text-gray-300 dark:text-slate-600" />
          <p className="font-medium text-gray-700 dark:text-slate-300">No scripts or schedulers found on this device</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-slate-700">
                <th className="table-header px-4 py-2.5 w-8" />
                <th className="table-header px-4 py-2.5">Kind</th>
                <th className="table-header px-4 py-2.5">Name</th>
                <th className="table-header px-4 py-2.5">Status</th>
                <th className="table-header px-4 py-2.5">Runs</th>
                <th className="table-header px-4 py-2.5">Last started</th>
                <th className="table-header px-4 py-2.5">Sync</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
              {scripts.map((row) => {
                const isOpen = expanded.has(row.id);
                const managedSource = managedSourceFor(row);
                const canDiff = row.sync_status === 'drifted' && managedSource !== null;
                return (
                  <Fragment key={row.id}>
                    <tr className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                      <td className="px-4 py-2.5">
                        {canDiff && (
                          <button onClick={() => toggleExpand(row.id)} className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">
                            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-2.5"><KindBadge kind={row.kind} /></td>
                      <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">
                        {row.name}
                        {row.disabled && (
                          <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400">disabled</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 dark:text-slate-400">{row.disabled ? 'Disabled' : 'Enabled'}</td>
                      <td className="px-4 py-2.5 text-gray-600 dark:text-slate-300">{row.run_count ?? '—'}</td>
                      <td className="px-4 py-2.5 text-xs text-gray-400 dark:text-slate-500 whitespace-nowrap">
                        {row.last_started ? new Date(row.last_started).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <SyncPill status={row.sync_status} />
                          {canDiff && (
                            <button onClick={() => toggleExpand(row.id)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap">
                              View diff
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isOpen && canDiff && (
                      <tr>
                        <td colSpan={7} className="p-0">
                          <DiffView deviceSource={row.source} managedSource={managedSource!} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
