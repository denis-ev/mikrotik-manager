import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Save, RefreshCw, AlertCircle, CheckCircle } from 'lucide-react';
import { devicesApi } from '../../services/api';
import type { Device } from '../../types';
import { useCanWrite } from '../../hooks/useCanWrite';

interface Props {
  device: Device;
}

const LOG_SOURCE_OPTIONS: { value: 'pull' | 'syslog' | 'both' | 'none'; label: string }[] = [
  { value: 'pull', label: 'Pull (polled logs)' },
  { value: 'syslog', label: 'Syslog (pushed)' },
  { value: 'both', label: 'Both' },
  { value: 'none', label: 'None' },
];

export default function DeviceLoggingSection({ device }: Props) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();

  const [logSource, setLogSource] = useState<'pull' | 'syslog' | 'both' | 'none'>(
    (device.log_source as 'pull' | 'syslog' | 'both' | 'none') || 'pull'
  );
  const [syslogSourceIp, setSyslogSourceIp] = useState('');
  const [nologThreshold, setNologThreshold] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState('');

  // Re-sync local form state whenever the underlying device record changes
  // (e.g. after a save, or a fresh navigation to this device).
  useEffect(() => {
    setLogSource((device.log_source as 'pull' | 'syslog' | 'both' | 'none') || 'pull');
  }, [device.log_source]);

  const mutation = useMutation({
    mutationFn: () =>
      devicesApi.updateLogConfig(device.id, {
        log_source: logSource,
        syslog_source_ip: syslogSourceIp.trim() || null,
        nolog_threshold_min: nologThreshold.trim() ? parseInt(nologThreshold, 10) : null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['device', device.id] });
      queryClient.invalidateQueries({ queryKey: ['devices'] });
      setSaveError('');
      setSaveSuccess('Logging settings saved');
      setTimeout(() => setSaveSuccess(''), 3000);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setSaveError(msg || 'Failed to save logging settings');
    },
  });

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-4">
        <FileText className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Logging</h3>
        {device.nolog && (
          <span className="ml-1 text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400">
            nolog
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className="label">Log Source</label>
          <select
            className="input w-full disabled:opacity-50 disabled:cursor-not-allowed"
            value={logSource}
            onChange={(e) => setLogSource(e.target.value as typeof logSource)}
            disabled={!canWrite}
          >
            {LOG_SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Syslog Source IP Override</label>
          <input
            className="input w-full disabled:opacity-50 disabled:cursor-not-allowed"
            value={syslogSourceIp}
            onChange={(e) => setSyslogSourceIp(e.target.value)}
            placeholder={device.ip_address}
            disabled={!canWrite}
          />
          <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Blank matches by device IP address.</p>
        </div>
        <div>
          <label className="label">No-Log Threshold (min)</label>
          <input
            type="number"
            className="input w-full disabled:opacity-50 disabled:cursor-not-allowed"
            value={nologThreshold}
            onChange={(e) => setNologThreshold(e.target.value)}
            placeholder="Global default"
            min="1"
            disabled={!canWrite}
          />
          <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">Blank uses the fleet-wide default.</p>
        </div>
      </div>

      {saveError && (
        <div className="flex items-center gap-2 mt-3 text-sm text-red-500">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {saveError}
        </div>
      )}
      {saveSuccess && (
        <div className="flex items-center gap-2 mt-3 text-sm text-green-500">
          <CheckCircle className="w-4 h-4 flex-shrink-0" /> {saveSuccess}
        </div>
      )}

      {canWrite && (
        <div className="mt-4">
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="btn-primary flex items-center gap-2 text-sm"
          >
            {mutation.isPending
              ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" />Saving…</>
              : <><Save className="w-3.5 h-3.5" />Save</>
            }
          </button>
        </div>
      )}
    </div>
  );
}
