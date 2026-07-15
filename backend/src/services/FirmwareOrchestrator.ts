// Staged firmware rollout orchestrator.
//
// Executes a rollout wave-by-wave (wave 1 = canary), each device sequentially:
//   pre-upgrade backup → move RouterOS to the target build → wait through the
//   reboot → verify it came back healthy → (optionally) chase the RouterBOARD
//   firmware upgrade with its own reboot → next device.
// A failure marks the device failed and (with halt_on_failure) stops the whole
// rollout so a bad build never reaches the rest of the fleet. One rollout runs
// at a time; a lightweight scheduler starts rollouts whose scheduled_at has
// arrived (pair with a maintenance window by scheduling inside it).
//
// Two RouterOS delivery modes:
//   * target_version NULL  → channel path: install whatever the device's update
//     channel reports as latest (device downloads + installs + reboots itself).
//   * target_version set   → version-pinned path: resolve the CPU arch, refuse
//     downgrades / extra packages, deliver the exact .npk (device-side /tool
//     fetch or app-side download + SFTP upload), reboot to install, then verify
//     the reported version equals the pinned target exactly.

import { query, queryOne } from '../config/database';
import { DeviceCollector, DeviceRow } from './mikrotik/DeviceCollector';
import { BackupService } from './BackupService';
import { packageStore } from './firmware/PackageStore';
import { compareRosVersions, isDowngrade, extraEnabledPackages, npkFileName, npkUrl } from '../utils/routerosPackages';

const REBOOT_GRACE_MS = 25_000;      // let the device actually go down
const REBOOT_POLL_MS = 15_000;       // probe cadence while waiting
const REBOOT_TIMEOUT_MS = 12 * 60_000; // give slow flash writes room

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface RolloutRow {
  id: number; name: string; status: string;
  halt_on_failure: boolean; pre_backup: boolean;
  target_version: string | null; delivery: string;
  do_routerboard: boolean; allow_downgrade: boolean;
}
interface RolloutDeviceRow {
  id: number; rollout_id: number; device_id: number; wave: number; status: string;
}

export class FirmwareOrchestrator {
  private activeRolloutId: number | null = null;
  private cancelRequested = false;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private backupService = new BackupService();

  get running(): number | null { return this.activeRolloutId; }

  startScheduler(): void {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => {
      this.startDueRollouts().catch(e => console.error('[Firmware] scheduler error:', e));
    }, 60_000);
  }

  stopScheduler(): void {
    if (this.schedulerTimer) { clearInterval(this.schedulerTimer); this.schedulerTimer = null; }
  }

  private async startDueRollouts(): Promise<void> {
    if (this.activeRolloutId) return;
    const due = await queryOne<{ id: number }>(
      `SELECT id FROM firmware_rollouts
       WHERE status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC LIMIT 1`);
    if (due) await this.start(due.id).catch(e => console.error(`[Firmware] scheduled start of #${due.id} failed:`, e));
  }

  async start(rolloutId: number): Promise<void> {
    if (this.activeRolloutId) throw new Error(`Rollout #${this.activeRolloutId} is already running`);
    const rollout = await queryOne<RolloutRow>(`SELECT * FROM firmware_rollouts WHERE id = $1`, [rolloutId]);
    if (!rollout) throw new Error('Rollout not found');
    if (rollout.status !== 'pending') throw new Error(`Rollout is ${rollout.status} — only pending rollouts can start`);

    this.activeRolloutId = rolloutId;
    this.cancelRequested = false;
    await query(`UPDATE firmware_rollouts SET status='running', started_at=NOW() WHERE id=$1`, [rolloutId]);

    // Fire-and-forget the run loop; callers poll status via the API.
    void this.run(rollout).catch(async (e) => {
      console.error(`[Firmware] rollout #${rolloutId} crashed:`, e);
      await query(`UPDATE firmware_rollouts SET status='failed', finished_at=NOW() WHERE id=$1`, [rolloutId]);
    }).finally(() => { this.activeRolloutId = null; });
  }

  cancel(rolloutId: number): void {
    if (this.activeRolloutId === rolloutId) this.cancelRequested = true;
  }

  private async run(rollout: RolloutRow): Promise<void> {
    const items = await query<RolloutDeviceRow>(
      `SELECT * FROM firmware_rollout_devices WHERE rollout_id=$1 ORDER BY wave ASC, id ASC`,
      [rollout.id]);

    let halted = false;
    for (const item of items) {
      if (this.cancelRequested || halted) {
        await query(`UPDATE firmware_rollout_devices SET status='skipped',
          error=$2 WHERE id=$1 AND status='pending'`,
          [item.id, this.cancelRequested ? 'Rollout cancelled' : 'Halted: earlier device failed']);
        continue;
      }
      const ok = await this.upgradeDevice(rollout, item);
      if (!ok && rollout.halt_on_failure) halted = true;
    }

    const finalStatus = this.cancelRequested ? 'cancelled' : halted ? 'failed' : 'completed';
    await query(`UPDATE firmware_rollouts SET status=$2, finished_at=NOW() WHERE id=$1`, [rollout.id, finalStatus]);
    console.log(`[Firmware] rollout #${rollout.id} ${finalStatus}`);

    if (finalStatus === 'completed' || finalStatus === 'failed') {
      const counts = await queryOne<{ ok: string; failed: string }>(
        `SELECT COUNT(*) FILTER (WHERE status='success')::text AS ok,
                COUNT(*) FILTER (WHERE status='failed')::text  AS failed
         FROM firmware_rollout_devices WHERE rollout_id=$1`, [rollout.id]);
      void import('./WebhookService').then(({ webhookService }) =>
        webhookService.dispatch(finalStatus === 'completed' ? 'rollout_completed' : 'rollout_failed', {
          rollout_id: rollout.id, name: rollout.name,
          succeeded: parseInt(counts?.ok || '0', 10), failed: parseInt(counts?.failed || '0', 10),
        })
      ).catch(() => {});
    }
  }

  private async setItem(id: number, fields: Record<string, string | null>): Promise<void> {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
    await query(`UPDATE firmware_rollout_devices SET ${sets} WHERE id=$1`, [id, ...keys.map(k => fields[k])]);
  }

  /** Mark a device item failed (+ finished_at) and return false for the caller to propagate. */
  private async failItem(itemId: number, deviceName: string, error: string): Promise<boolean> {
    console.error(`[Firmware] ${deviceName}: ${error}`);
    await this.setItem(itemId, { status: 'failed', error });
    await query(`UPDATE firmware_rollout_devices SET finished_at=NOW() WHERE id=$1`, [itemId]);
    return false;
  }

  /**
   * Wait out a reboot: grace period, then poll with a fresh collector until the
   * device answers /system/resource or the timeout elapses. Returns whether it
   * came back and the RouterOS version it reported.
   */
  private async rideReboot(device: DeviceRow): Promise<{ online: boolean; version: string }> {
    await sleep(REBOOT_GRACE_MS);
    const deadline = Date.now() + REBOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.cancelRequested) break;
      const probe = new DeviceCollector(device);
      try {
        await probe.connect();
        const resource = await probe.getSystemResource();
        const version = (resource['version'] || '').split(' ')[0];
        probe.disconnect();
        return { online: true, version };
      } catch {
        probe.disconnect();
        await sleep(REBOOT_POLL_MS);
      }
    }
    return { online: false, version: '' };
  }

  private async upgradeDevice(rollout: RolloutRow, item: RolloutDeviceRow): Promise<boolean> {
    const device = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id=$1`, [item.device_id]);
    if (!device) {
      await this.setItem(item.id, { status: 'failed', error: 'Device no longer exists' });
      return false;
    }

    await query(`UPDATE firmware_rollout_devices SET started_at=NOW() WHERE id=$1`, [item.id]);
    const fromVersion = (device.ros_version || '').trim();
    await this.setItem(item.id, { from_version: fromVersion || null });

    // 1. Pre-upgrade backup (common to both delivery paths)
    if (rollout.pre_backup) {
      await this.setItem(item.id, { status: 'backing_up' });
      try {
        await this.backupService.createBackup({
          id: device.id, name: device.name, ip_address: device.ip_address,
          ssh_port: device.ssh_port ?? 22, ssh_username: device.ssh_username,
          ssh_password_encrypted: device.ssh_password_encrypted,
          api_username: device.api_username, api_password_encrypted: device.api_password_encrypted,
        }, `Pre-upgrade backup (rollout "${rollout.name}")`, 'pre-upgrade');
      } catch (e) {
        return this.failItem(item.id, device.name, `Pre-upgrade backup failed: ${(e as Error).message}`);
      }
    }

    const target = (rollout.target_version || '').trim();
    return target
      ? this.upgradeToVersion(rollout, item, device, fromVersion)
      : this.upgradeToChannelLatest(rollout, item, device, fromVersion);
  }

  // ── Channel-latest path (target_version NULL) — device self-updates ──────────
  private async upgradeToChannelLatest(
    rollout: RolloutRow, item: RolloutDeviceRow, device: DeviceRow, fromVersion: string,
  ): Promise<boolean> {
    await this.setItem(item.id, { status: 'upgrading' });
    const collector = new DeviceCollector(device);
    try {
      await collector.connect();
      const status = await collector.checkForUpdates();
      const installed = (status['installed-version'] || '').trim();
      const latest = (status['latest-version'] || '').trim();
      if (!latest || latest === installed) {
        // Nothing to install, but the RouterBOARD firmware may still lag behind.
        collector.disconnect();
        const rbOk = await this.runRouterboardStage(rollout, item, device);
        if (!rbOk) return false;
        await this.setItem(item.id, { status: 'skipped', error: 'Already up to date', to_version: installed || null });
        await query(`UPDATE firmware_rollout_devices SET finished_at=NOW() WHERE id=$1`, [item.id]);
        return true;
      }
      await collector.installUpdate();
    } catch (e) {
      collector.disconnect();
      return this.failItem(item.id, device.name, `Update install failed: ${(e as Error).message}`);
    }
    collector.disconnect();

    // Ride out the reboot
    await this.setItem(item.id, { status: 'rebooting' });
    const { online, version } = await this.rideReboot(device);
    await this.setItem(item.id, { status: 'verifying' });
    if (!online) {
      return this.failItem(item.id, device.name, `Device did not come back online within ${Math.round(REBOOT_TIMEOUT_MS / 60000)} minutes after the upgrade — check it manually (a pre-upgrade backup ${rollout.pre_backup ? 'exists' : 'was NOT taken'})`);
    }
    if (version && fromVersion && version === fromVersion) {
      return this.failItem(item.id, device.name, `Device rebooted but still reports ${version} — the update did not apply`);
    }

    // RouterBOARD stage
    const rbOk = await this.runRouterboardStage(rollout, item, device);
    if (!rbOk) return false;

    return this.markSuccess(item, device, version, null);
  }

  // ── Version-pinned path (target_version set) ─────────────────────────────────
  private async upgradeToVersion(
    rollout: RolloutRow, item: RolloutDeviceRow, device: DeviceRow, fromVersion: string,
  ): Promise<boolean> {
    const target = (rollout.target_version || '').trim();

    // Downgrade guard / already-on-target
    if (fromVersion && compareRosVersions(target, fromVersion) === 0) {
      await this.setItem(item.id, { status: 'skipped', error: 'Already on target version', to_version: fromVersion });
      await query(`UPDATE firmware_rollout_devices SET finished_at=NOW() WHERE id=$1`, [item.id]);
      return true;
    }
    if (isDowngrade(target, fromVersion) && !rollout.allow_downgrade) {
      return this.failItem(item.id, device.name, `Refusing to downgrade ${device.name} from ${fromVersion} to ${target} — enable allow_downgrade to override`);
    }

    await this.setItem(item.id, { status: 'upgrading' });
    let arch = (device.architecture || '').trim();
    const collector = new DeviceCollector(device);
    try {
      await collector.connect();

      // Resolve arch (cached column, else fresh from the device)
      if (!arch) {
        const resource = await collector.getSystemResource();
        arch = (resource['architecture-name'] || '').trim();
      }
      if (!arch) {
        collector.disconnect();
        return this.failItem(item.id, device.name, `Could not determine the CPU architecture of ${device.name} — cannot pick the right package`);
      }
      await this.setItem(item.id, { arch });

      // Extra-package guard: refuse rather than break a device that needs more than the base bundle
      const packages = await collector.getPackages();
      const extras = extraEnabledPackages(packages, target);
      if (extras.length) {
        collector.disconnect();
        return this.failItem(item.id, device.name, `extra packages present: ${extras.join(', ')} — auto-handling not supported yet`);
      }

      // Deliver the exact .npk
      await this.setItem(item.id, { status: 'fetching' });
      const fileName = npkFileName(target, arch);
      if (rollout.delivery === 'upload') {
        const localPath = await packageStore.ensureLocalPackage(target, arch, fileName);
        await packageStore.uploadToDevice(device, localPath, fileName);
      } else {
        await collector.fetchFile(npkUrl(target, arch), fileName);
      }

      // Confirm the package is on the device before we reboot into the install
      const files = await collector.getFiles(fileName);
      if (!files.some((f) => f.name === fileName && f.size > 0)) {
        collector.disconnect();
        return this.failItem(item.id, device.name, `Package ${fileName} is not present on ${device.name} after delivery`);
      }

      // Reboot to install — RouterOS drops the connection, so a socket error here is expected
      await this.setItem(item.id, { status: 'rebooting' });
      try { await collector.reboot(); } catch { /* connection drops as the device goes down */ }
    } catch (e) {
      collector.disconnect();
      return this.failItem(item.id, device.name, `Version upgrade failed: ${(e as Error).message}`);
    }
    collector.disconnect();

    // Ride out the reboot and verify the EXACT version landed
    const { online, version } = await this.rideReboot(device);
    await this.setItem(item.id, { status: 'verifying' });
    if (!online) {
      return this.failItem(item.id, device.name, `Device did not come back online within ${Math.round(REBOOT_TIMEOUT_MS / 60000)} minutes after the upgrade — check it manually (a pre-upgrade backup ${rollout.pre_backup ? 'exists' : 'was NOT taken'})`);
    }
    if (version !== target) {
      return this.failItem(item.id, device.name, `Device rebooted on ${version || 'unknown'} but ${target} was requested — the update did not apply (a pre-upgrade backup ${rollout.pre_backup ? 'exists' : 'was NOT taken'})`);
    }

    // RouterBOARD stage
    const rbOk = await this.runRouterboardStage(rollout, item, device);
    if (!rbOk) return false;

    return this.markSuccess(item, device, version, arch);
  }

  /**
   * Optional RouterBOARD firmware stage. When do_routerboard is false the
   * routerboard_status is left NULL. Otherwise: skip if already current, else run
   * the upgrade (which reboots), ride the reboot, and confirm the firmware moved.
   * Returns false (and fails the device item) on any RouterBOARD failure.
   */
  private async runRouterboardStage(rollout: RolloutRow, item: RolloutDeviceRow, device: DeviceRow): Promise<boolean> {
    if (!rollout.do_routerboard) return true; // leave routerboard_status NULL

    const collector = new DeviceCollector(device);
    let needsUpgrade: boolean;
    try {
      await collector.connect();
      const rb = await collector.checkRouterboardUpgrade();
      needsUpgrade = rb.upgradeAvailable;
    } catch (e) {
      collector.disconnect();
      await this.setItem(item.id, { routerboard_status: 'failed' });
      return this.failItem(item.id, device.name, `RouterBOARD firmware check failed: ${(e as Error).message}`);
    }

    if (!needsUpgrade) {
      collector.disconnect();
      await this.setItem(item.id, { routerboard_status: 'skipped' });
      return true;
    }

    await this.setItem(item.id, { routerboard_status: 'upgrading' });
    try {
      await collector.installRouterboardUpgrade(); // runs /system/routerboard/upgrade + /system/reboot
    } catch { /* the reboot drops the connection — expected */ }
    collector.disconnect();

    const { online } = await this.rideReboot(device);
    if (!online) {
      await this.setItem(item.id, { routerboard_status: 'failed' });
      return this.failItem(item.id, device.name, `Device did not come back online after the RouterBOARD firmware upgrade (a pre-upgrade backup ${rollout.pre_backup ? 'exists' : 'was NOT taken'})`);
    }

    // Confirm current-firmware caught up to upgrade-firmware
    const verify = new DeviceCollector(device);
    try {
      await verify.connect();
      const rb2 = await verify.checkRouterboardUpgrade();
      verify.disconnect();
      if (!rb2.upgradeAvailable) {
        await this.setItem(item.id, { routerboard_status: 'success' });
        return true;
      }
      await this.setItem(item.id, { routerboard_status: 'failed' });
      return this.failItem(item.id, device.name, `RouterBOARD firmware is still ${rb2.currentFirmware}, expected ${rb2.upgradeFirmware}`);
    } catch (e) {
      verify.disconnect();
      await this.setItem(item.id, { routerboard_status: 'failed' });
      return this.failItem(item.id, device.name, `RouterBOARD firmware verify failed: ${(e as Error).message}`);
    }
  }

  /** Final success bookkeeping shared by both paths. arch is refreshed when known. */
  private async markSuccess(item: RolloutDeviceRow, device: DeviceRow, version: string, arch: string | null): Promise<boolean> {
    await this.setItem(item.id, { status: 'success', to_version: version || null });
    await query(`UPDATE firmware_rollout_devices SET finished_at=NOW() WHERE id=$1`, [item.id]);
    await query(
      `UPDATE devices SET ros_version=COALESCE(NULLIF($2,''), ros_version),
              architecture=COALESCE(NULLIF($3,''), architecture),
              firmware_update_available=FALSE, status='online', last_seen=NOW() WHERE id=$1`,
      [device.id, version, arch || '']);
    console.log(`[Firmware] ${device.name}: upgraded to ${version || 'unknown'}`);
    return true;
  }
}

export const firmwareOrchestrator = new FirmwareOrchestrator();
