import { app } from 'electron';
import type { UpdateInfo, UpdateCheckResult } from '../shared/types';

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

/**
 * Query the GitHub releases API and classify the result: an available update,
 * already up to date, or a failed check (network/API error). Powers both the
 * background poller and the on-demand "Check for updates" button.
 */
export async function checkForUpdatesDetailed(): Promise<UpdateCheckResult> {
  const current = app.getVersion();
  try {
    const res = await fetch(API_URL, {
      headers: { 'User-Agent': `CtrlC/${current}` },
    });
    if (!res.ok) {
      console.warn(`[Update] GitHub API returned ${res.status} ${res.statusText}`);
      return { status: 'error' };
    }
    const data = await res.json() as {
      tag_name: string;
      html_url: string;
      published_at: string;
      draft: boolean;
      prerelease: boolean;
    };
    if (data.draft || data.prerelease) return { status: 'current', version: current };
    if (!isNewer(data.tag_name, current)) return { status: 'current', version: current };
    return {
      status: 'available',
      info: {
        version: data.tag_name,
        url: data.html_url,
        publishedAt: data.published_at,
      },
    };
  } catch (err) {
    console.warn('[Update] check failed:', (err as Error).message);
    return { status: 'error' };
  }
}

export async function checkForUpdates(): Promise<UpdateInfo | null> {
  const result = await checkForUpdatesDetailed();
  return result.status === 'available' ? result.info : null;
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
