// Opening the game page in the player's browser.
//
// Why not `rundll32 url.dll,FileProtocolHandler` (the usual one-liner): it runs *inside* the caller's token, so a
// launcher started from an elevated console starts Edge/Chrome **elevated** too — and from then on Edge greets the
// player with 「Microsoft Edge 未响应，因为现有实例正在以提升的权限运行。是否要用普通权限重启现有实例? 是/否」
// instead of just opening the page. Handing the URL to the shell (`explorer.exe <url>`) lets the already-running,
// non-elevated Explorer forward it to the default browser, which is the documented way to de-elevate a launch.
//
// Ladder (Windows): SP_BROWSER override → explorer.exe (shell association = 默认浏览器) → rundll32 (legacy
// fallback). Anything that cannot even be spawned falls through to the next one.
//
// There is deliberately no `cmd /c start "" <url>` rung: cmd re-parses everything after `/c`, so a URL holding an
// `&` (e.g. the room link `?room=ABCD&name=…`) is split at the `&` — cmd runs `start "" <url-up-to-&>` and then
// tries to run the remainder as a second command. The browser then opens a truncated address, or a stray console
// window flashes. Passing an argument array to CreateProcess avoids the shell entirely, which is why the other
// rungs are safe.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Does this path exist? Injectable as `exists` so the ladder can be tested without the host's filesystem. */
function realExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/**
 * Absolute path of a system executable, or the bare name when it is not where we expect it.
 *
 * Built with **win32** semantics whatever the host is: the value is handed to a Windows process, and the ladder is
 * also inspected from tests (CI runs them on Linux, where `path.join` is posix and would emit `C:\Windows/explorer.exe`
 * — a mixed-separator string that never matches a real Windows path).
 * @param {NodeJS.ProcessEnv} env
 * @param {string} sub subdirectory under the Windows root ('' / '.' for the root itself)
 * @param {string} name
 * @param {(p: string) => boolean} exists
 */
function systemExe(env, sub, name, exists) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  const abs = path.win32.join(root, sub || '.', name);
  return exists(abs) ? abs : name;
}

/** Split `SP_BROWSER` into [exe, ...extraArgs]; a quoted path is unwrapped. */
export function parseBrowserCommand(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const m = /^"([^"]+)"\s*(.*)$/.exec(s);
  if (m) return [m[1], ...(m[2].trim() ? m[2].trim().split(/\s+/) : [])];
  const parts = s.split(/\s+/);
  return parts[0] ? parts : null;
}

/**
 * Candidate launch commands for `url`, best first.
 * @param {string} url
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, exists?: (p: string) => boolean }} [o]
 *   `exists` defaults to the real filesystem; pass one in to test the Windows ladder from any host.
 * @returns {{ cmd: string, args: string[], label: string }[]}
 */
export function browserCommands(url, { platform = process.platform, env = process.env, exists = realExists } = {}) {
  const out = [];
  const custom = parseBrowserCommand(env.SP_BROWSER);
  if (custom) out.push({ cmd: custom[0], args: [...custom.slice(1), url], label: 'SP_BROWSER' });
  if (platform === 'win32') {
    // shell association: default browser, and the request is served by the non-elevated Explorer process
    out.push({ cmd: systemExe(env, '.', 'explorer.exe', exists), args: [url], label: 'explorer' });
    // legacy fallback only; `cmd /c start` is intentionally absent (it truncates URLs at `&` — see the header)
    out.push({ cmd: systemExe(env, 'System32', 'rundll32.exe', exists), args: ['url.dll,FileProtocolHandler', url], label: 'rundll32' });
  } else if (platform === 'darwin') {
    out.push({ cmd: 'open', args: [url], label: 'open' });
  } else if (env.DISPLAY || env.WAYLAND_DISPLAY) {
    out.push({ cmd: 'xdg-open', args: [url], label: 'xdg-open' });
  }
  return out;
}

/**
 * Open `url` with the player's default browser. Returns the label of the launcher that was spawned, or null when
 * nothing could be started (headless Linux, missing system binaries) — callers then just print the URL.
 * @param {string} url
 * @param {{ spawnImpl?: typeof spawn, platform?: string, env?: NodeJS.ProcessEnv,
 *           exists?: (p: string) => boolean, log?: (m: string) => void }} [o]
 * @returns {string | null}
 */
export function openBrowser(url, { spawnImpl = spawn, platform = process.platform, env = process.env, exists = realExists, log } = {}) {
  for (const { cmd, args, label } of browserCommands(url, { platform, env, exists })) {
    try {
      const child = spawnImpl(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
      if (!child || typeof child.unref !== 'function') continue;
      // ENOENT arrives asynchronously; the caller prints the URL anyway, so nothing to retry here.
      child.on?.('error', () => {});
      child.unref();
      return label;
    } catch (err) {
      log?.(`${label}: ${err?.code || err?.message || err}`);
    }
  }
  return null;
}
