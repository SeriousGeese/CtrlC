import { app } from 'electron';
import type { UpdateInfo } from '../shared/types';

const REPO = 'SeriousGeese/CtrlC';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const STARTUP_DELAY_MS = 30_000;
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const parts = v.replace(/^v/, '').split('.').map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

export async function checkForUpdates(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(API_URL, {
      headers: { 'User-Agent': `CtrlC/${app.getVersion()}` },
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      tag_name: string;
      html_url: string;
      published_at: string;
      draft: boolean;
      prerelease: boolean;
    };
    if (data.draft || data.prerelease) return null;
    if (!isNewer(data.tag_name, app.getVersion())) return null;
    return {
      version: data.tag_name,
      url: data.html_url,
      publishedAt: data.published_at,
    };
  } catch {
    return null;
  }
}

export function startUpdatePoller(onUpdate: (info: UpdateInfo) => void): void {
  const poll = async (): Promise<void> => {
    const info = await checkForUpdates();
    if (info) onUpdate(info);
  };

  setTimeout(() => {
    void poll();
    setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}
