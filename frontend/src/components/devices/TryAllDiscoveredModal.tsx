import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Loader2, CheckCircle, AlertCircle, KeyRound } from 'lucide-react';
import { credentialPresetsApi, devicesApi, type DiscoveredDevice } from '../../services/api';
import type { DeviceType } from '../../types';

interface Props {
  discoveredDevices: DiscoveredDevice[];
  onClose: () => void;
  onSuccess: () => void;
}

type ResultItem = { ip: string; identity: string; ok: boolean; message: string };

export default function TryAllDiscoveredModal({ discoveredDevices, onClose, onSuccess }: Props) {
  const [mode, setMode] = useState<'preset' | 'manual'>('preset');
  const [presetId, setPresetId] = useState<number | null>(null);
  const [manual, setManual] = useState({
    api_username: 'admin',
    api_password: '',
    api_port: '8728',
    ssh_username: '',
    ssh_password: '',
    ssh_port: '22',
    device_type: 'router' as DeviceType,
  });
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ResultItem[] | null>(null);
  const [error, setError] = useState('');

  const { data: presets = [] } = useQuery({
    queryKey: ['credential-presets'],
    queryFn: () => credentialPresetsApi.list().then((r) => r.data),
    staleTime: 30_000,
  });

  const targets = useMemo(
    () => discoveredDevices.filter((d) => d.address && d.address.trim().length > 0),
    [discoveredDevices]
  );

  const handleRun = async () => {
    setError('');
    setResults(null);
    if (!targets.length) {
      setError('No discovered devices with a usable IP address.');
      return;
    }
    if (mode === 'preset' && !presetId) {
      setError('Choose a credential preset or switch to manual.');
      return;
    }
    if (mode === 'manual' && (!manual.api_username || !manual.api_password)) {
      setError('Manual mode requires API username and password.');
      return;
    }

    setRunning(true);
    const out: ResultItem[] = [];
    for (const d of targets) {
      const payload =
        mode === 'preset'
          ? {
              name: d.identity || d.address,
              ip_address: d.address,
              credential_preset_id: presetId!,
            }
          : {
              name: d.identity || d.address,
              ip_address: d.address,
              api_username: manual.api_username,
              api_password: manual.api_password,
              api_port: parseInt(manual.api_port, 10) || 8728,
              ssh_username: manual.ssh_username || undefined,
              ssh_password: manual.ssh_password || undefined,
              ssh_port: parseInt(manual.ssh_port, 10) || 22,
              device_type: manual.device_type,
            };
      try {
        await devicesApi.create(payload);
        out.push({ ip: d.address, identity: d.identity || d.address, ok: true, message: 'Added' });
      } catch (err: unknown) {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed';
        out.push({ ip: d.address, identity: d.identity || d.address, ok: false, message: msg });
      }
    }
    setResults(out);
    setRunning(false);
  };

  const okCount = results?.filter((r) => r.ok).length ?? 0;
  const failCount = results?.filter((r) => !r.ok).length ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="card w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Try All Discovered Devices</h2>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-sm text-gray-600 dark:text-slate-300">
            Attempt to add <strong>{targets.length}</strong> discovered device(s) in one run.
          </p>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode('preset')}
              className={`px-3 py-1.5 rounded-lg text-sm border ${mode === 'preset' ? 'bg-blue-600 text-white border-blue-600' : 'text-gray-600 dark:text-slate-300 border-gray-300 dark:border-slate-600'}`}
            >
              Use Preset
            </button>
            <button
              type="button"
              onClick={() => setMode('manual')}
              className={`px-3 py-1.5 rounded-lg text-sm border ${mode === 'manual' ? 'bg-blue-600 text-white border-blue-600' : 'text-gray-600 dark:text-slate-300 border-gray-300 dark:border-slate-600'}`}
            >
              Enter Manually
            </button>
          </div>

          {mode === 'preset' ? (
            <div>
              <label className="label flex items-center gap-1.5"><KeyRound className="w-3.5 h-3.5" />Credential Preset</label>
              <select className="input" value={presetId ?? ''} onChange={(e) => setPresetId(e.target.value ? parseInt(e.target.value, 10) : null)}>
                <option value="">Select preset...</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.api_username}{p.ssh_username ? ` · SSH ${p.ssh_username}` : ''})
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">API Username *</label>
                <input className="input" value={manual.api_username} onChange={(e) => setManual((m) => ({ ...m, api_username: e.target.value }))} />
              </div>
              <div>
                <label className="label">API Port</label>
                <input className="input" type="number" value={manual.api_port} onChange={(e) => setManual((m) => ({ ...m, api_port: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <label className="label">API Password *</label>
                <input className="input" type="password" value={manual.api_password} onChange={(e) => setManual((m) => ({ ...m, api_password: e.target.value }))} />
              </div>
              <div>
                <label className="label">SSH Username</label>
                <input className="input" value={manual.ssh_username} onChange={(e) => setManual((m) => ({ ...m, ssh_username: e.target.value }))} />
              </div>
              <div>
                <label className="label">SSH Port</label>
                <input className="input" type="number" value={manual.ssh_port} onChange={(e) => setManual((m) => ({ ...m, ssh_port: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <label className="label">SSH Password</label>
                <input className="input" type="password" value={manual.ssh_password} onChange={(e) => setManual((m) => ({ ...m, ssh_password: e.target.value }))} />
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          {results && (
            <div className="space-y-2">
              <div className="text-sm text-gray-700 dark:text-slate-300">
                Done: <span className="text-green-600 dark:text-green-400">{okCount} succeeded</span>,{' '}
                <span className="text-red-600 dark:text-red-400">{failCount} failed</span>
              </div>
              <div className="max-h-56 overflow-y-auto border border-gray-200 dark:border-slate-700 rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 dark:bg-slate-700/50 sticky top-0">
                    <tr>
                      <th className="table-header px-3 py-2 text-left">Device</th>
                      <th className="table-header px-3 py-2 text-left">IP</th>
                      <th className="table-header px-3 py-2 text-left">Result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                    {results.map((r) => (
                      <tr key={`${r.ip}-${r.identity}`}>
                        <td className="px-3 py-2 text-gray-700 dark:text-slate-300">{r.identity}</td>
                        <td className="px-3 py-2 font-mono text-gray-500 dark:text-slate-400">{r.ip}</td>
                        <td className="px-3 py-2">
                          {r.ok ? (
                            <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                              <CheckCircle className="w-3.5 h-3.5" /> {r.message}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                              <AlertCircle className="w-3.5 h-3.5" /> {r.message}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary">Close</button>
            <button
              type="button"
              onClick={handleRun}
              disabled={running}
              className="btn-primary flex items-center gap-2"
            >
              {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
              {running ? 'Trying...' : `Try All (${targets.length})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
