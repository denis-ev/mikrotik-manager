import { AlertTriangle, GitMerge, RefreshCcw, X } from 'lucide-react';
import type { DuplicateSerialError } from '../../services/api';

interface Props {
  duplicate: DuplicateSerialError;
  pendingName: string;
  pendingIp: string;
  onCancel: () => void;
  onCombine: () => void;
  onReplace: () => void;
  loading: boolean;
}

export default function ConfirmDuplicateModal({
  duplicate,
  pendingName,
  pendingIp,
  onCancel,
  onCombine,
  onReplace,
  loading,
}: Props) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="card w-full max-w-xl mx-4">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            Duplicate serial detected
          </h3>
          <button onClick={onCancel} disabled={loading} className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-sm text-gray-600 dark:text-slate-300">
            Serial <span className="font-mono">{duplicate.candidate.serial_number}</span> already exists on a managed device.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-3">
              <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">Existing managed device</p>
              <p className="text-sm font-medium text-gray-900 dark:text-white">{duplicate.existing_device.name}</p>
              <p className="text-xs text-gray-500 dark:text-slate-400">{duplicate.existing_device.ip_address}</p>
            </div>
            <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-3">
              <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">New device request</p>
              <p className="text-sm font-medium text-gray-900 dark:text-white">{pendingName}</p>
              <p className="text-xs text-gray-500 dark:text-slate-400">{pendingIp}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onCancel} disabled={loading} className="btn-secondary">
              Cancel
            </button>
            <button type="button" onClick={onCombine} disabled={loading} className="btn-secondary inline-flex items-center gap-2">
              <GitMerge className="w-4 h-4" />
              Combine into existing
            </button>
            <button type="button" onClick={onReplace} disabled={loading} className="btn-primary inline-flex items-center gap-2">
              <RefreshCcw className="w-4 h-4" />
              Replace existing details
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
