// LID (Linked Identifier) ↔ phone-number resolution.
//
// Baileys persists mappings under `<authDir>/lid-mapping-<LID>_reverse.json`
// where the file's content is a JSON string containing the phone digits, e.g.
//
//     lid-mapping-100030006444102_reverse.json  →  "584247267291"
//
// We load every such file at startup into an in-memory Map<lid, phone> for
// sync hot-path lookups, then watch the directory so any new mapping files
// Baileys writes mid-session are picked up automatically.

import * as fs from 'fs';
import * as path from 'path';

const FILE_REGEX = /^lid-mapping-(\d+)_reverse\.json$/;

const lidToPn = new Map<string, string>();
let watcher: fs.FSWatcher | null = null;

function tryReadMapping(authDir: string, fileName: string): void {
  const m = FILE_REGEX.exec(fileName);
  if (!m) return;
  const lid = m[1]!;
  try {
    const raw = fs.readFileSync(path.join(authDir, fileName), 'utf8');
    const pn = JSON.parse(raw);
    if (typeof pn === 'string' && /^\d+$/.test(pn)) {
      lidToPn.set(lid, pn);
    }
  } catch {
    // Half-written or removed since the watcher fired — ignore; we'll catch the next event.
  }
}

export function initLidStore(authDir: string): void {
  lidToPn.clear();
  if (watcher) {
    watcher.close();
    watcher = null;
  }

  if (!fs.existsSync(authDir)) return;

  for (const name of fs.readdirSync(authDir)) {
    tryReadMapping(authDir, name);
  }
  console.log(`LID store loaded: ${lidToPn.size} mappings.`);

  try {
    watcher = fs.watch(authDir, (_event, fileName) => {
      if (fileName) tryReadMapping(authDir, fileName);
    });
  } catch (err) {
    // fs.watch can fail on some filesystems (network mounts, etc.). Cache
    // stays useful without the watcher; new mappings will simply be missed
    // until the next restart.
    console.warn(
      `LID store: fs.watch unavailable (${err instanceof Error ? err.message : String(err)}). ` +
        `Cache is static for this session.`,
    );
  }
}

// Returns the phone JID (`<digits>@s.whatsapp.net`) for an @lid JID we have
// mapped, or null if no mapping is known.
export function lidToPhoneJid(lid: string): string | null {
  // Accept either a full `<id>@lid` JID or just the bare digits.
  const idPart = lid.split('@')[0]!.split(':')[0]!;
  const pn = lidToPn.get(idPart);
  return pn ? `${pn}@s.whatsapp.net` : null;
}

export function isLidJid(jid: string | undefined | null): boolean {
  return !!jid && jid.endsWith('@lid');
}

// If `jid` is an @lid we can resolve, return the phone JID. Otherwise return
// `jid` unchanged. Group JIDs (`@g.us`) and phone JIDs pass through as-is.
export function canonicalJid(jid: string): string {
  if (!isLidJid(jid)) return jid;
  return lidToPhoneJid(jid) ?? jid;
}

export function lidStoreSize(): number {
  return lidToPn.size;
}
