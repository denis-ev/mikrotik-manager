import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw, Plus, Trash2, CheckCircle, AlertCircle, Download, Server,
} from 'lucide-react';
import { devicesApi } from '../../services/api';
import type { IpAddress, Interface } from '../../types';
import clsx from 'clsx';
import { useCanWrite } from '../../hooks/useCanWrite';

interface Props {
  deviceId: number;
}

export default function SystemConfigTab({ deviceId }: Props) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();

  // ─── System config (identity, NTP, DNS) ──────────────────────────────────
  const { data: sysConfig, isLoading: sysLoading } = useQuery({
    queryKey: ['system-config', deviceId],
    queryFn: () => devicesApi.getSystemConfig(deviceId).then((r) => r.data),
  });

  // ─── Clock ────────────────────────────────────────────────────────────────
  const { data: clockData, isLoading: clockLoading } = useQuery({
    queryKey: ['device-clock', deviceId],
    queryFn: () => devicesApi.getClock(deviceId).then((r) => r.data),
  });

  // ─── Combined edit state ──────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [sysForm, setSysForm] = useState({
    identity: '',
    ntp_enabled: true,
    ntp_primary: '',
    ntp_secondary: '',
    dns_servers: '',
    dns_allow_remote: false,
  });
  const [clockForm, setClockForm] = useState({ date: '', time: '', timezone: '' });
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState('');
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    if (!sysConfig) return;
    setSysForm({
      identity: sysConfig.identity,
      ntp_enabled: sysConfig.ntp.enabled !== 'no',
      ntp_primary: sysConfig.ntp['primary-ntp'] || '',
      ntp_secondary: sysConfig.ntp['secondary-ntp'] || '',
      dns_servers: sysConfig.dns['servers'] || '',
      dns_allow_remote: sysConfig.dns['allow-remote-requests'] === 'yes',
    });
    setClockForm({
      date: clockData?.date || '',
      time: clockData?.time || '',
      timezone: clockData?.timezone || '',
    });
    setSaveError('');
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      await devicesApi.updateSystemConfig(deviceId, sysForm);
      await devicesApi.setClock(deviceId, clockForm);
      queryClient.invalidateQueries({ queryKey: ['system-config', deviceId] });
      queryClient.invalidateQueries({ queryKey: ['device-clock', deviceId] });
      queryClient.invalidateQueries({ queryKey: ['device', deviceId] });
      setEditing(false);
      setSaveSuccess('System configuration updated');
      setTimeout(() => setSaveSuccess(''), 3000);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setSaveError(msg || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  // ─── IP Addresses ────────────────────────────────────────────────────────
  const { data: ipAddresses = [], isLoading: ipLoading, refetch: refetchIp } = useQuery({
    queryKey: ['ip-addresses', deviceId],
    queryFn: () => devicesApi.getIpAddresses(deviceId).then((r) => r.data as IpAddress[]),
  });

  const { data: interfaces = [] } = useQuery({
    queryKey: ['interfaces', deviceId],
    queryFn: () => devicesApi.getInterfaces(deviceId).then((r) => r.data as Interface[]),
  });

  const [newIp, setNewIp] = useState({ address: '', interface: '' });
  const [ipError, setIpError] = useState('');

  const addIpMutation = useMutation({
    mutationFn: () => devicesApi.addIpAddress(deviceId, newIp),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ip-addresses', deviceId] });
      setNewIp({ address: '', interface: '' });
      setIpError('');
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setIpError(msg || 'Failed to add IP address');
    },
  });

  const removeIpMutation = useMutation({
    mutationFn: (id: string) => devicesApi.removeIpAddress(deviceId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ip-addresses', deviceId] }),
  });

  // ─── Firmware check / install ─────────────────────────────────────────────
  const [updateInfo, setUpdateInfo] = useState<Record<string, string> | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const [installSuccess, setInstallSuccess] = useState('');

  const checkUpdateMutation = useMutation({
    mutationFn: () => devicesApi.checkUpdate(deviceId),
    onMutate: () => { setUpdateChecking(true); setUpdateError(''); setUpdateInfo(null); setInstallSuccess(''); },
    onSuccess: (res) => { setUpdateInfo(res.data); setUpdateChecking(false); },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setUpdateError(msg || 'Failed to check for updates');
      setUpdateChecking(false);
    },
  });

  const installUpdateMutation = useMutation({
    mutationFn: () => devicesApi.installUpdate(deviceId),
    onSuccess: () => {
      setUpdateInfo(null);
      setInstallSuccess('Update installation initiated. The device will reboot shortly.');
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setUpdateError(msg || 'Failed to install update');
    },
  });

  // RouterOS 7 uses 'installed-version'; RouterOS 6 uses 'version'
  const installedVersion = updateInfo?.['installed-version'] || updateInfo?.['version'] || '';
  const latestVersion    = updateInfo?.['latest-version'] || '';
  const statusSaysUpdate = updateInfo?.['status']?.toLowerCase().includes('new version') ||
                           updateInfo?.['status']?.toLowerCase().includes('available');
  const hasUpdate = updateInfo && latestVersion && (
    (installedVersion && latestVersion !== installedVersion) ||
    (!installedVersion && statusSaysUpdate)
  );

  const isLoading = sysLoading || clockLoading;

  return (
    <div className="space-y-6">
      {/* ── System Settings (identity, NTP, DNS, clock) ── */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Server className="w-4 h-4 text-blue-500" />
            System Settings
          </h3>
          {canWrite && !editing && (
            <button
              onClick={startEdit}
              disabled={isLoading || !sysConfig}
              className="btn-secondary text-xs py-1.5"
            >
              Edit
            </button>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading...
          </div>
        ) : !sysConfig ? (
          <div className="text-sm text-gray-400">Could not load system configuration</div>
        ) : editing ? (
          <div className="space-y-5">
            {/* Identity */}
            <div>
              <label className="label">Device Identity (Hostname)</label>
              <input
                className="input"
                value={sysForm.identity}
                onChange={(e) => setSysForm((f) => ({ ...f, identity: e.target.value }))}
                placeholder="router"
              />
            </div>

            {/* Date / Time / Timezone */}
            <div>
              <h4 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                Date &amp; Time
              </h4>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="label">Date</label>
                  <input
                    type="date"
                    className="input"
                    value={clockForm.date}
                    onChange={(e) => setClockForm((f) => ({ ...f, date: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="label">Time</label>
                  <input
                    type="time"
                    className="input"
                    value={clockForm.time}
                    onChange={(e) => setClockForm((f) => ({ ...f, time: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="label">Timezone</label>
                  <input
                    className="input"
                    value={clockForm.timezone}
                    onChange={(e) => setClockForm((f) => ({ ...f, timezone: e.target.value }))}
                    placeholder="America/New_York"
                  />
                  <p className="text-xs text-gray-400 mt-1">IANA name (e.g. UTC, Europe/London)</p>
                </div>
              </div>
            </div>

            {/* NTP */}
            <div>
              <h4 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                NTP Client
              </h4>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="ntp_enabled"
                    checked={sysForm.ntp_enabled}
                    onChange={(e) => setSysForm((f) => ({ ...f, ntp_enabled: e.target.checked }))}
                    className="w-4 h-4"
                  />
                  <label htmlFor="ntp_enabled" className="text-sm text-gray-700 dark:text-slate-300">
                    NTP enabled
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Primary NTP server</label>
                    <input
                      className="input"
                      value={sysForm.ntp_primary}
                      onChange={(e) => setSysForm((f) => ({ ...f, ntp_primary: e.target.value }))}
                      placeholder="0.pool.ntp.org"
                    />
                  </div>
                  <div>
                    <label className="label">Secondary NTP server</label>
                    <input
                      className="input"
                      value={sysForm.ntp_secondary}
                      onChange={(e) => setSysForm((f) => ({ ...f, ntp_secondary: e.target.value }))}
                      placeholder="1.pool.ntp.org"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* DNS */}
            <div>
              <h4 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                DNS
              </h4>
              <div className="space-y-2">
                <div>
                  <label className="label">DNS Servers (comma-separated)</label>
                  <input
                    className="input"
                    value={sysForm.dns_servers}
                    onChange={(e) => setSysForm((f) => ({ ...f, dns_servers: e.target.value }))}
                    placeholder="8.8.8.8,8.8.4.4"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="dns_remote"
                    checked={sysForm.dns_allow_remote}
                    onChange={(e) => setSysForm((f) => ({ ...f, dns_allow_remote: e.target.checked }))}
                    className="w-4 h-4"
                  />
                  <label htmlFor="dns_remote" className="text-sm text-gray-700 dark:text-slate-300">
                    Allow remote DNS requests (act as DNS server)
                  </label>
                </div>
              </div>
            </div>

            {saveError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                onClick={handleSave}
                disabled={saving}
                className="btn-primary flex items-center gap-2"
              >
                {saving && <RefreshCw className="w-4 h-4 animate-spin" />}
                Save Changes
              </button>
              <button onClick={() => setEditing(false)} className="btn-secondary">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-y-3 gap-x-8 text-sm">
            {[
              ['Identity', sysConfig.identity || '—'],
              ['Date', clockData?.date || '—'],
              ['Time', clockData?.time || '—'],
              ['Timezone', clockData?.timezone || '—'],
              ['NTP Enabled', sysConfig.ntp.enabled !== 'no' ? 'Yes' : 'No'],
              ['Primary NTP', sysConfig.ntp['primary-ntp'] || '—'],
              ['Secondary NTP', sysConfig.ntp['secondary-ntp'] || '—'],
              ['DNS Servers', sysConfig.dns.servers || '—'],
              ['Allow Remote DNS', sysConfig.dns['allow-remote-requests'] === 'yes' ? 'Yes' : 'No'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-gray-100 dark:border-slate-700 pb-2">
                <span className="text-gray-500 dark:text-slate-400">{k}</span>
                <span className="font-medium text-gray-900 dark:text-white text-right">{v}</span>
              </div>
            ))}
          </div>
        )}

        {saveSuccess && (
          <div className="flex items-center gap-2 mt-3 text-sm text-green-600">
            <CheckCircle className="w-4 h-4" /> {saveSuccess}
          </div>
        )}
      </div>

      {/* ── IP Addresses ── */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-slate-700">
          <h3 className="font-semibold text-gray-900 dark:text-white">IP Addresses</h3>
          <button
            onClick={() => refetchIp()}
            className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={clsx('w-3.5 h-3.5', ipLoading && 'animate-spin')} />
          </button>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-slate-700">
              <th className="table-header px-4 py-2 text-left">Address / Prefix</th>
              <th className="table-header px-4 py-2 text-left">Network</th>
              <th className="table-header px-4 py-2 text-left">Interface</th>
              <th className="table-header px-4 py-2 text-left">Status</th>
              <th className="table-header px-4 py-2 w-12" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
            {ipLoading ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400">Loading...</td></tr>
            ) : (ipAddresses as IpAddress[]).length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400">No IP addresses</td></tr>
            ) : (
              (ipAddresses as IpAddress[]).map((ip) => (
                <tr key={ip['.id']} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                  <td className="px-4 py-2 font-mono text-gray-900 dark:text-white">{ip.address}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-500 dark:text-slate-400">{ip.network || '—'}</td>
                  <td className="px-4 py-2 text-gray-600 dark:text-slate-300">{ip.interface}</td>
                  <td className="px-4 py-2">
                    <span className={clsx(
                      'text-xs font-medium',
                      ip.disabled === 'true' ? 'text-gray-400' : 'text-green-600 dark:text-green-400'
                    )}>
                      {ip.dynamic === 'true' ? 'dynamic' : ip.disabled === 'true' ? 'disabled' : 'active'}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {canWrite && ip.dynamic !== 'true' && (
                      <button
                        onClick={() => {
                          if (confirm(`Remove ${ip.address} from ${ip.interface}?`)) {
                            removeIpMutation.mutate(ip['.id']);
                          }
                        }}
                        className="p-1 rounded text-gray-400 hover:text-red-500 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {canWrite && <div className="p-4 border-t border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="label">Address / Prefix (e.g. 192.168.1.1/24)</label>
              <input
                className="input font-mono"
                value={newIp.address}
                onChange={(e) => setNewIp((f) => ({ ...f, address: e.target.value }))}
                placeholder="192.168.1.1/24"
              />
            </div>
            <div className="w-44">
              <label className="label">Interface</label>
              <select
                className="input"
                value={newIp.interface}
                onChange={(e) => setNewIp((f) => ({ ...f, interface: e.target.value }))}
              >
                <option value="">Select...</option>
                {(interfaces as Interface[]).map((i) => (
                  <option key={i.name} value={i.name}>{i.name}</option>
                ))}
              </select>
            </div>
            <button
              onClick={() => addIpMutation.mutate()}
              disabled={!newIp.address || !newIp.interface || addIpMutation.isPending}
              className="btn-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
          </div>
          {ipError && (
            <div className="flex items-center gap-2 mt-2 text-sm text-red-500">
              <AlertCircle className="w-4 h-4" /> {ipError}
            </div>
          )}
        </div>}
      </div>

      {/* ── Firmware Updates ── */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Download className="w-4 h-4 text-blue-500" />
            Firmware Updates
          </h3>
          <button
            onClick={() => checkUpdateMutation.mutate()}
            disabled={updateChecking}
            className="btn-secondary flex items-center gap-2 text-sm"
          >
            <RefreshCw className={clsx('w-4 h-4', updateChecking && 'animate-spin')} />
            {updateChecking ? 'Checking...' : 'Check for Updates'}
          </button>
        </div>

        {updateError && (
          <div className="flex items-center gap-2 text-sm text-red-500 mb-3">
            <AlertCircle className="w-4 h-4" /> {updateError}
          </div>
        )}

        {installSuccess && (
          <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 mb-3">
            <CheckCircle className="w-4 h-4" /> {installSuccess}
          </div>
        )}

        {updateInfo && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4 text-sm">
              {[
                ['Status', updateInfo['status'] || '—'],
                ['Installed Version', installedVersion || '—'],
                ['Latest Version', latestVersion || '—'],
                ['Channel', updateInfo['channel'] || '—'],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between border-b border-gray-100 dark:border-slate-700 pb-2">
                  <span className="text-gray-500 dark:text-slate-400">{k}</span>
                  <span className={clsx(
                    'font-medium text-right',
                    k === 'Status' && hasUpdate ? 'text-orange-500' : 'text-gray-900 dark:text-white'
                  )}>
                    {v}
                  </span>
                </div>
              ))}
            </div>

            {hasUpdate ? (
              <div className="flex items-center gap-3 p-3 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg">
                <AlertCircle className="w-4 h-4 text-orange-500 flex-shrink-0" />
                <div className="flex-1 text-sm">
                  <p className="font-medium text-orange-700 dark:text-orange-400">
                    Update available: {latestVersion}
                  </p>
                  <p className="text-orange-600 dark:text-orange-500 text-xs mt-0.5">
                    The device will reboot after installing.
                  </p>
                </div>
                {canWrite && (
                  <button
                    onClick={() => {
                      if (confirm(`Install RouterOS ${latestVersion} and reboot the device?`)) {
                        installUpdateMutation.mutate();
                      }
                    }}
                    disabled={installUpdateMutation.isPending}
                    className="btn-primary flex items-center gap-2 text-sm flex-shrink-0"
                  >
                    {installUpdateMutation.isPending
                      ? <RefreshCw className="w-4 h-4 animate-spin" />
                      : <Download className="w-4 h-4" />}
                    Install &amp; Reboot
                  </button>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <CheckCircle className="w-4 h-4" />
                RouterOS is up to date
              </div>
            )}
          </div>
        )}

        {!updateInfo && !updateChecking && !installSuccess && (
          <p className="text-sm text-gray-400 dark:text-slate-500">
            Click &quot;Check for Updates&quot; to query the MikroTik update server.
          </p>
        )}
      </div>
    </div>
  );
}
