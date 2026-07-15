// Local .npk cache + SFTP delivery for version-pinned firmware rollouts.
//
// When a rollout delivers packages by uploading (rather than device-side
// /tool fetch), the app downloads the .npk from download.mikrotik.com once into
// a cache dir (sibling of the backups volume, so it lives on the same persistent
// volume) and then pushes it to each device over SFTP — reusing the same ssh2
// connection + decrypted-credential pattern as BackupService.

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { Client as SSHClient } from 'ssh2';
import { decrypt } from '../../utils/crypto';
import { DeviceRow } from '../mikrotik/DeviceCollector';
import { npkUrl } from '../../utils/routerosPackages';

// Backups live on a persistent volume at /app/backups (see docker-compose /
// backend/Dockerfile). Keep the firmware cache as a sibling so it shares that
// volume rather than the ephemeral container filesystem.
const BACKUPS_DIR = process.env.BACKUPS_DIR || '/app/backups';
const FIRMWARE_CACHE_DIR = process.env.FIRMWARE_CACHE_DIR || path.join(path.dirname(BACKUPS_DIR), 'firmware-cache');

// Hardcoded download host — the only origin we will ever pull an .npk from.
const DOWNLOAD_HOST = 'download.mikrotik.com';
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export class PackageStore {
  /**
   * Ensure the base bundle .npk for (version, arch) exists in the local cache and
   * return its path. Downloads from download.mikrotik.com on a cache miss; any
   * other host is rejected. A cached file with size > 0 is reused as-is.
   */
  async ensureLocalPackage(version: string, arch: string, fileName: string): Promise<string> {
    if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
      throw new Error(`Refusing unsafe package file name: ${fileName}`);
    }
    const dir = path.join(FIRMWARE_CACHE_DIR, version);
    const dest = path.join(dir, fileName);

    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;

    const url = npkUrl(version, arch);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== DOWNLOAD_HOST) {
      throw new Error(`Refusing to download package from ${parsed.hostname} (only ${DOWNLOAD_HOST} is allowed)`);
    }

    fs.mkdirSync(dir, { recursive: true });
    await this.download(url, dest);

    if (!fs.existsSync(dest) || fs.statSync(dest).size <= 0) {
      throw new Error(`Downloaded package ${fileName} is empty`);
    }
    return dest;
  }

  /** Upload a local .npk to the device's file root over SFTP (fastPut). */
  uploadToDevice(device: DeviceRow, localPath: string, remoteName: string): Promise<void> {
    const sshUser = device.ssh_username || device.api_username;
    const sshPass = device.ssh_password_encrypted
      ? decrypt(device.ssh_password_encrypted)
      : decrypt(device.api_password_encrypted);
    const port = device.ssh_port || 22;

    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('SFTP timeout during package upload'));
      }, UPLOAD_TIMEOUT_MS);

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) {
            clearTimeout(timeout);
            conn.end();
            return reject(err);
          }
          sftp.fastPut(localPath, remoteName, (e) => {
            clearTimeout(timeout);
            conn.end();
            if (e) return reject(e);
            resolve();
          });
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      conn.connect({ host: device.ip_address, port, username: sshUser, password: sshPass, readyTimeout: 15_000 });
    });
  }

  /** Stream an https URL to disk. Follows a single same-host redirect. */
  private download(url: string, dest: string, redirectsLeft = 3): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }, (resp) => {
        const status = resp.statusCode || 0;

        // Follow redirects, but only within the allowed host.
        if (status >= 300 && status < 400 && resp.headers.location) {
          resp.resume();
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects downloading package'));
          const next = new URL(resp.headers.location, url);
          if (next.protocol !== 'https:' || next.hostname !== DOWNLOAD_HOST) {
            return reject(new Error(`Refusing redirect to ${next.hostname}`));
          }
          return resolve(this.download(next.toString(), dest, redirectsLeft - 1));
        }

        if (status !== 200) {
          resp.resume();
          return reject(new Error(`Download failed (HTTP ${status}) for ${url}`));
        }

        const out = fs.createWriteStream(dest);
        resp.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', (e) => {
          fs.unlink(dest, () => reject(e));
        });
      });

      req.on('timeout', () => req.destroy(new Error('Download timed out')));
      req.on('error', (e) => {
        fs.unlink(dest, () => reject(e));
      });
    });
  }
}

export const packageStore = new PackageStore();
