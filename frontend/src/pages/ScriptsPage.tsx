import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FileCode, ScrollText, Plus, Search, X, Save, Trash2, RefreshCw, CheckCircle, XCircle,
  AlertTriangle, Link2, Loader2, AlertCircle,
} from 'lucide-react';
import clsx from 'clsx';
import { formatDistanceToNow } from 'date-fns';
import { scriptsApi } from '../services/api';
import type {
  ManagedScript, ManagedScriptDevice, ScriptSuggestion, ScriptCandidate, UnlinkedScript,
  ScriptKind, ScriptLinkResult, ScriptLinkStrategy, ScriptSchedule, ScriptSyncStatus,
} from '../services/api';
import { useCanWrite } from '../hooks/useCanWrite';
import { useSocket } from '../hooks/useSocket';

// ─── Shared constants ───────────────────────────────────────────────────────────

const POLICIES = ['read', 'write', 'policy', 'test', 'ftp', 'reboot', 'password', 'sniff', 'sensitive', 'romon'] as const;

const SYNC_META: Record<ScriptSyncStatus, { label: string; cls: string }> = {
  in_sync:     { label: 'In sync',    cls: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' },
  drifted:     { label: 'Drifted',    cls: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400' },
  stale:       { label: 'Stale',      cls: 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400' },
  push_failed: { label: 'Push failed', cls: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400' },
  unlinked:    { label: 'Unlinked',   cls: 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400' },
};

function errMsg(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return msg || fallback;
}
function isStatus(err: unknown, code: number): boolean {
  return (err as { response?: { status?: number } })?.response?.status === code;
}

interface ActionResults {
  label: string;
  results: { name: string; ok: boolean; error?: string }[];
}

// ─── Small presentational bits ──────────────────────────────────────────────────

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

function SyncPill({ status }: { status: ScriptSyncStatus }) {
  const meta = SYNC_META[status] ?? SYNC_META.unlinked;
  return <span className={clsx('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium', meta.cls)}>{meta.label}</span>;
}

function SyncSummary({ devices }: { devices: ManagedScriptDevice[] }) {
  const counts: Record<string, number> = {};
  for (const d of devices) counts[d.sync_status] = (counts[d.sync_status] ?? 0) + 1;
  const order: ScriptSyncStatus[] = ['in_sync', 'drifted', 'stale', 'push_failed'];
  const chips = order.filter((s) => counts[s] > 0);
  if (chips.length === 0) return <span className="text-xs text-gray-400 dark:text-slate-500">no devices</span>;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {chips.map((s) => (
        <span key={s} className={clsx('inline-flex items-center px-1.5 py-0.5 rounded-full text-[11px] font-medium', SYNC_META[s].cls)}>
          {counts[s]} {SYNC_META[s].label.toLowerCase()}
        </span>
      ))}
    </div>
  );
}

function ResultsPanel({ results, onClose }: { results: ActionResults; onClose: () => void }) {
  const okCount = results.results.filter((r) => r.ok).length;
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-slate-200">{results.label}</h3>
        <span className="text-xs text-gray-400 dark:text-slate-500">{okCount}/{results.results.length} succeeded</span>
        <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-slate-800">
        {results.results.map((r, i) => (
          <div key={`${r.name}-${i}`} className="flex items-center gap-3 px-5 py-2.5">
            {r.ok ? <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" /> : <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />}
            <span className="text-sm font-medium text-gray-800 dark:text-slate-200">{r.name}</span>
            {r.error && <span className="text-xs text-red-500 ml-2 truncate">{r.error}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Link-strategy resolution dialog ─────────────────────────────────────────────

interface StrategyRequest {
  managedId: number;
  deviceScriptIds: number[];
  label: string;
}

function StrategyDialog({
  request, onResolve, onCancel, isPending,
}: {
  request: StrategyRequest;
  onResolve: (strategy: ScriptLinkStrategy) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-xl w-full max-w-sm">
        <div className="flex items-start gap-3 p-5">
          <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Content differs</h3>
            <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
              {request.label} — the device's content doesn't match the managed version. Choose how to resolve it.
            </p>
          </div>
        </div>
        <div className="px-5 pb-5 space-y-2">
          <button
            onClick={() => onResolve('push_managed')}
            disabled={isPending}
            className="w-full text-left px-3 py-2.5 rounded-lg border border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50 transition-colors disabled:opacity-50"
          >
            <div className="text-sm font-medium text-gray-900 dark:text-white">Push managed version to device</div>
            <div className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">Overwrite the device's script/scheduler with the managed source.</div>
          </button>
          <button
            onClick={() => onResolve('adopt_device_version')}
            disabled={isPending}
            className="w-full text-left px-3 py-2.5 rounded-lg border border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50 transition-colors disabled:opacity-50"
          >
            <div className="text-sm font-medium text-gray-900 dark:text-white">Adopt device version into managed</div>
            <div className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">Replace the managed source with what's currently on the device.</div>
          </button>
        </div>
        <div className="px-5 pb-5 flex justify-end">
          <button onClick={onCancel} disabled={isPending} className="px-4 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors disabled:opacity-50">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Editor drawer ───────────────────────────────────────────────────────────────

interface DrawerState {
  mode: 'new' | 'edit';
  managed?: ManagedScript;
}

function EditorDrawer({
  state, canWrite, onClose, onChanged,
}: {
  state: DrawerState;
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const managed = state.managed;
  const [kind, setKind] = useState<ScriptKind>(managed?.kind ?? 'script');
  const [name, setName] = useState(managed?.name ?? '');
  const [source, setSource] = useState(managed?.source ?? '');
  const [description, setDescription] = useState(managed?.description ?? '');
  const [policy, setPolicy] = useState<Set<string>>(
    new Set((managed?.policy ?? '').split(',').map((p) => p.trim()).filter(Boolean))
  );
  const [interval, setInterval_] = useState(managed?.schedule?.interval ?? '');
  const [startDate, setStartDate] = useState(managed?.schedule?.start_date ?? '');
  const [startTime, setStartTime] = useState(managed?.schedule?.start_time ?? '');

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [pushResults, setPushResults] = useState<ScriptLinkResult[] | null>(null);
  const [deleteChoice, setDeleteChoice] = useState<'keep' | 'strip-marker' | 'delete' | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pushing, setPushing] = useState(false);

  const togglePolicy = (p: string) => {
    setPolicy((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  };

  const buildSchedule = (): ScriptSchedule | undefined => {
    if (kind !== 'scheduler') return undefined;
    const s: ScriptSchedule = {};
    if (interval.trim()) s.interval = interval.trim();
    if (startDate.trim()) s.start_date = startDate.trim();
    if (startTime.trim()) s.start_time = startTime.trim();
    return s;
  };

  const canSave = name.trim() !== '' && source.trim() !== '' && !saving;

  async function handleSave() {
    setSaving(true);
    setSaveError('');
    setConflict(false);
    try {
      if (state.mode === 'new') {
        await scriptsApi.createManaged({
          kind,
          name: name.trim(),
          source,
          policy: Array.from(policy).join(','),
          schedule: buildSchedule(),
          description: description.trim() || undefined,
        });
        onChanged();
        onClose();
      } else if (managed) {
        const res = await scriptsApi.update(managed.id, {
          name: name.trim(),
          source,
          policy: Array.from(policy).join(','),
          schedule: buildSchedule(),
          description: description.trim() || undefined,
          expected_updated_at: managed.updated_at,
        });
        setPushResults(res.data.results);
        onChanged();
      }
    } catch (err) {
      if (isStatus(err, 409)) {
        setConflict(true);
      } else {
        setSaveError(errMsg(err, 'Failed to save script'));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handlePushAll() {
    if (!managed) return;
    setPushing(true);
    try {
      const res = await scriptsApi.push(managed.id);
      setPushResults(res.data.results);
      onChanged();
    } catch (err) {
      setSaveError(errMsg(err, 'Push failed'));
    } finally {
      setPushing(false);
    }
  }

  async function handlePushOne(deviceId: number) {
    if (!managed) return;
    setPushing(true);
    try {
      const res = await scriptsApi.push(managed.id, [deviceId]);
      setPushResults(res.data.results);
      onChanged();
    } catch (err) {
      setSaveError(errMsg(err, 'Push failed'));
    } finally {
      setPushing(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!managed || !deleteChoice) return;
    setDeleting(true);
    try {
      await scriptsApi.remove(managed.id, deleteChoice);
      onChanged();
      onClose();
    } catch (err) {
      setSaveError(errMsg(err, 'Delete failed'));
      setDeleting(false);
    }
  }

  function resultFor(deviceId: number): ScriptLinkResult | undefined {
    return pushResults?.find((r) => r.device_id === deviceId);
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl h-full bg-white dark:bg-slate-800 shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-slate-700 flex-shrink-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">
            {state.mode === 'new' ? 'New managed script' : managed?.name}
          </h2>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {conflict && (
            <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm text-amber-700 dark:text-amber-400">This script changed elsewhere — reload to see the latest version before saving again.</p>
                <button onClick={() => { onChanged(); onClose(); }} className="mt-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 underline">
                  Reload
                </button>
              </div>
            </div>
          )}
          {saveError && (
            <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
            </div>
          )}

          {/* Name / kind */}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="label">Name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!canWrite} placeholder="my-script" />
            </div>
            <div>
              <label className="label">Kind</label>
              {state.mode === 'new' ? (
                <select className="input" value={kind} onChange={(e) => setKind(e.target.value as ScriptKind)} disabled={!canWrite}>
                  <option value="script">Script</option>
                  <option value="scheduler">Scheduler</option>
                </select>
              ) : (
                <div className="pt-1.5"><KindBadge kind={kind} /></div>
              )}
            </div>
          </div>

          {/* Scheduler timing fields */}
          {kind === 'scheduler' && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">Interval</label>
                <input className="input font-mono" value={interval} onChange={(e) => setInterval_(e.target.value)} disabled={!canWrite} placeholder="1d 00:00:00" />
              </div>
              <div>
                <label className="label">Start date</label>
                <input className="input font-mono" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={!canWrite} placeholder="jan/01/2026" />
              </div>
              <div>
                <label className="label">Start time</label>
                <input className="input font-mono" value={startTime} onChange={(e) => setStartTime(e.target.value)} disabled={!canWrite} placeholder="00:00:00" />
              </div>
            </div>
          )}

          {/* Source / on-event */}
          <div>
            <label className="label">{kind === 'scheduler' ? 'On Event' : 'Source'}</label>
            <textarea
              className="input font-mono text-xs leading-relaxed"
              rows={14}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              disabled={!canWrite}
              spellCheck={false}
            />
          </div>

          {/* Description */}
          <div>
            <label className="label">Description</label>
            <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canWrite} />
          </div>

          {/* Policy */}
          <div>
            <label className="label">Policy</label>
            <div className="grid grid-cols-3 gap-2">
              {POLICIES.map((p) => (
                <label key={p} className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={policy.has(p)}
                    onChange={() => togglePolicy(p)}
                    disabled={!canWrite}
                    className="rounded border-gray-300 dark:border-slate-600"
                  />
                  {p}
                </label>
              ))}
            </div>
          </div>

          {/* Devices + sync status */}
          {managed && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="label !mb-0">Devices ({managed.devices.length})</label>
                {canWrite && managed.devices.length > 0 && (
                  <button onClick={handlePushAll} disabled={pushing} className="btn-secondary text-xs flex items-center gap-1.5 !px-2.5 !py-1">
                    {pushing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Push to all
                  </button>
                )}
              </div>
              {managed.devices.length === 0 ? (
                <p className="text-sm text-gray-400 dark:text-slate-500">Not linked to any devices yet.</p>
              ) : (
                <div className="border border-gray-200 dark:border-slate-700 rounded-lg divide-y divide-gray-100 dark:divide-slate-700">
                  {managed.devices.map((d) => {
                    const result = resultFor(d.device_id);
                    return (
                      <div key={d.device_script_id} className="flex items-center gap-2 px-3 py-2 text-sm">
                        <span className="font-medium text-gray-800 dark:text-slate-200 truncate flex-1">{d.device_name}</span>
                        <SyncPill status={d.sync_status} />
                        {result && (result.ok
                          ? <span title="Pushed"><CheckCircle className="w-3.5 h-3.5 text-green-500" /></span>
                          : <span title={result.error || 'Push failed'}><XCircle className="w-3.5 h-3.5 text-red-500" /></span>)}
                        {canWrite && (d.sync_status === 'drifted' || d.sync_status === 'stale' || d.sync_status === 'push_failed') && (
                          <button onClick={() => handlePushOne(d.device_id)} disabled={pushing} className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex-shrink-0">
                            Push
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Delete */}
          {managed && canWrite && (
            <div className="pt-2 border-t border-gray-100 dark:border-slate-700">
              {deleteChoice === null ? (
                <button
                  onClick={() => setDeleteChoice('keep')}
                  className="flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400 hover:underline"
                >
                  <Trash2 className="w-3.5 h-3.5" />Delete managed script…
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-gray-800 dark:text-slate-200">Delete this managed script — what should happen on devices?</p>
                  <div className="space-y-1.5">
                    <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-slate-300">
                      <input type="radio" name="delete-choice" checked={deleteChoice === 'keep'} onChange={() => setDeleteChoice('keep')} className="mt-0.5" />
                      <span><strong>Keep on devices</strong> — leave the script/scheduler and its marker untouched.</span>
                    </label>
                    <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-slate-300">
                      <input type="radio" name="delete-choice" checked={deleteChoice === 'strip-marker'} onChange={() => setDeleteChoice('strip-marker')} className="mt-0.5" />
                      <span><strong>Remove marker only</strong> — keep the script but stop managing it.</span>
                    </label>
                    <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-slate-300">
                      <input type="radio" name="delete-choice" checked={deleteChoice === 'delete'} onChange={() => setDeleteChoice('delete')} className="mt-0.5" />
                      <span><strong>Delete from devices</strong> — remove the script/scheduler everywhere it's linked.</span>
                    </label>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button onClick={() => setDeleteChoice(null)} disabled={deleting} className="px-3 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors disabled:opacity-50">
                      Cancel
                    </button>
                    <button onClick={handleDeleteConfirm} disabled={deleting} className="btn-danger text-sm flex items-center gap-1.5">
                      {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      Confirm delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {canWrite && (
          <div className="px-5 py-4 border-t border-gray-200 dark:border-slate-700 flex justify-end gap-2 flex-shrink-0">
            <button onClick={onClose} className="btn-secondary">Cancel</button>
            <button onClick={handleSave} disabled={!canSave} className="btn-primary flex items-center gap-1.5">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Link-to-existing dialog (unlinked bulk action) ─────────────────────────────

function LinkExistingDialog({
  managedOptions, onLink, onClose, isPending,
}: {
  managedOptions: ManagedScript[];
  onLink: (managedId: number) => void;
  onClose: () => void;
  isPending: boolean;
}) {
  const [selected, setSelected] = useState<number | ''>(managedOptions[0]?.id ?? '');
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-xl w-full max-w-sm p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Link to existing managed script</h3>
        {managedOptions.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-slate-400">No managed scripts of a matching kind exist yet.</p>
        ) : (
          <select className="input" value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
            {managedOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={isPending} className="px-4 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={() => typeof selected === 'number' && onLink(selected)}
            disabled={isPending || typeof selected !== 'number'}
            className="btn-primary flex items-center gap-1.5"
          >
            {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
            Link
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────────

export default function ScriptsPage() {
  const canWrite = useCanWrite();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['scripts'],
    queryFn: () => scriptsApi.list().then((r) => r.data),
    refetchInterval: 60_000,
  });

  useSocket({
    'scripts:updated': () => { qc.invalidateQueries({ queryKey: ['scripts'] }); },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['scripts'] });

  const managed = data?.managed ?? [];
  const suggestions = data?.suggestions ?? [];
  const candidates = (data?.candidates ?? []).filter((c) => c.count >= 2 && c.items.length >= 2);
  const unlinked = data?.unlinked ?? [];

  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [strategyReq, setStrategyReq] = useState<StrategyRequest | null>(null);
  const [strategyPending, setStrategyPending] = useState(false);
  const [results, setResults] = useState<ActionResults | null>(null);
  const [actionError, setActionError] = useState('');

  // Unlinked inventory filters + selection
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | ScriptKind>('all');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [linkExistingOpen, setLinkExistingOpen] = useState(false);

  const filteredUnlinked = useMemo(() => {
    const q = search.trim().toLowerCase();
    return unlinked.filter((u) => {
      if (kindFilter !== 'all' && u.kind !== kindFilter) return false;
      if (!q) return true;
      return u.name.toLowerCase().includes(q) || u.device_name.toLowerCase().includes(q);
    });
  }, [unlinked, search, kindFilter]);

  const selectedRows = filteredUnlinked.filter((u) => selected.has(u.id));
  const selectedKinds = new Set(selectedRows.map((r) => r.kind));
  const selectionSameKind = selectedKinds.size <= 1;

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    if (selectedRows.length === filteredUnlinked.length && filteredUnlinked.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredUnlinked.map((u) => u.id)));
    }
  }

  // ── Link attempt with automatic strategy-required handling ─────────────────
  async function attemptLink(managedId: number, deviceScriptIds: number[], label: string, strategy?: ScriptLinkStrategy) {
    setActionError('');
    if (strategy) setStrategyPending(true);
    try {
      const res = await scriptsApi.link(managedId, deviceScriptIds, strategy);
      const byId = new Map(
        [...managed.flatMap((m) => m.devices.map((d) => [d.device_id, d.device_name] as const)),
         ...unlinked.map((u) => [u.device_id, u.device_name] as const)]
      );
      setResults({
        label,
        results: res.data.results.map((r) => ({ name: byId.get(r.device_id) ?? `Device ${r.device_id}`, ok: r.ok, error: r.error })),
      });
      setStrategyReq(null);
      setSelected(new Set());
      invalidate();
    } catch (err) {
      if (isStatus(err, 400) && !strategy) {
        setStrategyReq({ managedId, deviceScriptIds, label });
      } else {
        setActionError(errMsg(err, 'Link failed'));
        setStrategyReq(null);
      }
    } finally {
      setStrategyPending(false);
    }
  }

  async function handleManageCandidate(candidate: ScriptCandidate) {
    setActionError('');
    const [first, ...rest] = candidate.items;
    try {
      const res = await scriptsApi.adopt(first.device_script_id);
      const managedId = res.data.id;
      if (rest.length > 0) {
        await attemptLink(managedId, rest.map((r) => r.device_script_id), `Link "${candidate.name}"`);
      } else {
        setResults({ label: `Manage "${candidate.name}"`, results: [{ name: first.device_name, ok: true }] });
        invalidate();
      }
    } catch (err) {
      setActionError(errMsg(err, 'Failed to create managed script'));
    }
  }

  async function handleManageAsNew() {
    if (selectedRows.length === 0 || !selectionSameKind) return;
    setActionError('');
    const [first, ...rest] = selectedRows;
    try {
      const res = await scriptsApi.adopt(first.id);
      const managedId = res.data.id;
      if (rest.length > 0) {
        await attemptLink(managedId, rest.map((r) => r.id), `Manage "${first.name}"`);
      } else {
        setResults({ label: `Manage "${first.name}"`, results: [{ name: first.device_name, ok: true }] });
        setSelected(new Set());
        invalidate();
      }
    } catch (err) {
      setActionError(errMsg(err, 'Failed to create managed script'));
    }
  }

  const linkExistingOptions = managed.filter((m) => selectedKinds.size === 0 || m.kind === [...selectedKinds][0]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Scripts & Schedulers</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Manage RouterOS scripts and schedulers as version-controlled templates pushed across your fleet.
          </p>
        </div>
        {canWrite && (
          <button onClick={() => setDrawer({ mode: 'new' })} className="btn-primary flex items-center gap-1.5">
            <Plus className="w-4 h-4" />New managed script
          </button>
        )}
      </div>

      {actionError && (
        <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-600 dark:text-red-400">{actionError}</p>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-gray-400">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <>
          {/* ── Managed scripts ── */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700">
              <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">
                Managed scripts<span className="ml-2 text-xs font-normal text-gray-400 dark:text-slate-500">({managed.length})</span>
              </h2>
            </div>
            {managed.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-400 dark:text-slate-500">
                No managed scripts yet. Create one, or adopt content already discovered below.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-slate-700">
                      <th className="table-header px-4 py-2.5">Kind</th>
                      <th className="table-header px-4 py-2.5">Name</th>
                      <th className="table-header px-4 py-2.5">Devices</th>
                      <th className="table-header px-4 py-2.5">Sync</th>
                      <th className="table-header px-4 py-2.5">Updated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                    {managed.map((m) => (
                      <tr
                        key={m.id}
                        onClick={() => setDrawer({ mode: 'edit', managed: m })}
                        className="cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700/30"
                      >
                        <td className="px-4 py-2.5"><KindBadge kind={m.kind} /></td>
                        <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">{m.name}</td>
                        <td className="px-4 py-2.5 text-gray-600 dark:text-slate-300">{m.devices.length}</td>
                        <td className="px-4 py-2.5"><SyncSummary devices={m.devices} /></td>
                        <td className="px-4 py-2.5 text-xs text-gray-400 dark:text-slate-500 whitespace-nowrap">
                          {formatDistanceToNow(new Date(m.updated_at), { addSuffix: true })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Match candidates ── */}
          {candidates.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700">
                <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">
                  Match candidates<span className="ml-2 text-xs font-normal text-gray-400 dark:text-slate-500">({candidates.length})</span>
                </h2>
                <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">Identical content found on multiple devices, not yet managed.</p>
              </div>
              <div className="divide-y divide-gray-100 dark:divide-slate-800">
                {candidates.map((c) => (
                  <div key={`${c.kind}-${c.source_hash}`} className="flex items-center gap-3 px-5 py-3 flex-wrap">
                    <KindBadge kind={c.kind} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-900 dark:text-white truncate">{c.name}</div>
                      <div className="text-xs text-gray-400 dark:text-slate-500 truncate">
                        Found on {c.count} devices — {c.items.map((i) => i.device_name).join(', ')}
                      </div>
                    </div>
                    {canWrite && (
                      <button
                        onClick={() => handleManageCandidate(c)}
                        className="ml-auto btn-secondary text-xs flex items-center gap-1.5 !px-2.5 !py-1 flex-shrink-0"
                      >
                        <Link2 className="w-3.5 h-3.5" />Manage &amp; link all
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Suggestions ── */}
          {suggestions.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700">
                <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">
                  Suggestions<span className="ml-2 text-xs font-normal text-gray-400 dark:text-slate-500">({suggestions.length})</span>
                </h2>
                <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">Unlinked content that matches an existing managed script.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-slate-700">
                      <th className="table-header px-4 py-2.5">Kind</th>
                      <th className="table-header px-4 py-2.5">Device</th>
                      <th className="table-header px-4 py-2.5">Name</th>
                      <th className="table-header px-4 py-2.5">Matches</th>
                      <th className="table-header px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                    {suggestions.map((s) => (
                      <tr key={s.device_script_id}>
                        <td className="px-4 py-2.5"><KindBadge kind={s.kind} /></td>
                        <td className="px-4 py-2.5 text-gray-700 dark:text-slate-300">{s.device_name}</td>
                        <td className="px-4 py-2.5 text-gray-900 dark:text-white">{s.name}</td>
                        <td className="px-4 py-2.5 text-gray-500 dark:text-slate-400">{s.managed_name}</td>
                        <td className="px-4 py-2.5 text-right">
                          {canWrite && (
                            <button
                              onClick={() => attemptLink(s.managed_script_id, [s.device_script_id], `Link "${s.name}" to "${s.managed_name}"`)}
                              className="btn-secondary text-xs flex items-center gap-1.5 !px-2.5 !py-1 ml-auto"
                            >
                              <Link2 className="w-3.5 h-3.5" />Link
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Unlinked inventory ── */}
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-3 flex-wrap">
              <h2 className="text-sm font-semibold text-gray-700 dark:text-slate-200">
                Unlinked inventory<span className="ml-2 text-xs font-normal text-gray-400 dark:text-slate-500">({filteredUnlinked.length})</span>
              </h2>
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name or device…"
                  className="input !py-1.5 !pl-8 text-sm max-w-[16rem]"
                />
              </div>
              <select className="input !py-1.5 max-w-[9rem] text-sm" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as 'all' | ScriptKind)}>
                <option value="all">All kinds</option>
                <option value="script">Script</option>
                <option value="scheduler">Scheduler</option>
              </select>
              {canWrite && selectedRows.length > 0 && (
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-xs text-gray-400 dark:text-slate-500">{selectedRows.length} selected</span>
                  <button
                    onClick={handleManageAsNew}
                    disabled={!selectionSameKind}
                    title={!selectionSameKind ? 'Select rows of the same kind' : undefined}
                    className="btn-secondary text-xs flex items-center gap-1.5 !px-2.5 !py-1"
                  >
                    <Plus className="w-3.5 h-3.5" />Manage as new
                  </button>
                  <button
                    onClick={() => setLinkExistingOpen(true)}
                    disabled={!selectionSameKind}
                    title={!selectionSameKind ? 'Select rows of the same kind' : undefined}
                    className="btn-secondary text-xs flex items-center gap-1.5 !px-2.5 !py-1"
                  >
                    <Link2 className="w-3.5 h-3.5" />Link to existing…
                  </button>
                </div>
              )}
            </div>
            {filteredUnlinked.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-400 dark:text-slate-500">No unlinked scripts match.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-slate-700">
                      {canWrite && (
                        <th className="table-header px-4 py-2.5 w-8">
                          <input
                            type="checkbox"
                            checked={filteredUnlinked.length > 0 && selectedRows.length === filteredUnlinked.length}
                            onChange={toggleSelectAll}
                            className="rounded border-gray-300 dark:border-slate-600"
                          />
                        </th>
                      )}
                      <th className="table-header px-4 py-2.5">Kind</th>
                      <th className="table-header px-4 py-2.5">Name</th>
                      <th className="table-header px-4 py-2.5">Device</th>
                      <th className="table-header px-4 py-2.5">Comment</th>
                      <th className="table-header px-4 py-2.5">Status</th>
                      <th className="table-header px-4 py-2.5">Last seen</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                    {filteredUnlinked.map((u) => (
                      <tr key={u.id}>
                        {canWrite && (
                          <td className="px-4 py-2.5">
                            <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggleSelect(u.id)} className="rounded border-gray-300 dark:border-slate-600" />
                          </td>
                        )}
                        <td className="px-4 py-2.5"><KindBadge kind={u.kind} /></td>
                        <td className="px-4 py-2.5 text-gray-900 dark:text-white">
                          <span className="flex items-center gap-1.5">
                            {u.name}
                            {u.orphaned_marker && (
                              <span title="Marker exists but no managed script — adopt or strip">
                                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-gray-600 dark:text-slate-300">{u.device_name}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-400 dark:text-slate-500 truncate max-w-[12rem]">{u.comment || '—'}</td>
                        <td className="px-4 py-2.5">
                          {u.disabled
                            ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400">Disabled</span>
                            : <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">Enabled</span>}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-400 dark:text-slate-500 whitespace-nowrap">
                          {u.last_seen ? formatDistanceToNow(new Date(u.last_seen), { addSuffix: true }) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {results && <ResultsPanel results={results} onClose={() => setResults(null)} />}
        </>
      )}

      {drawer && (
        <EditorDrawer
          state={drawer}
          canWrite={canWrite}
          onClose={() => setDrawer(null)}
          onChanged={invalidate}
        />
      )}

      {strategyReq && (
        <StrategyDialog
          request={strategyReq}
          isPending={strategyPending}
          onCancel={() => setStrategyReq(null)}
          onResolve={(strategy) => attemptLink(strategyReq.managedId, strategyReq.deviceScriptIds, strategyReq.label, strategy)}
        />
      )}

      {linkExistingOpen && (
        <LinkExistingDialog
          managedOptions={linkExistingOptions}
          isPending={false}
          onClose={() => setLinkExistingOpen(false)}
          onLink={(managedId) => {
            setLinkExistingOpen(false);
            const label = `Link ${selectedRows.length} script${selectedRows.length !== 1 ? 's' : ''} to existing managed script`;
            attemptLink(managedId, selectedRows.map((r) => r.id), label);
          }}
        />
      )}
    </div>
  );
}
