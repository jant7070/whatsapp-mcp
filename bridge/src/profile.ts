// Profile read/write helpers — thin wrappers around the Baileys socket so
// routes can stay declarative.

import { getSock } from './baileys';

export interface MyProfile {
  jid: string;
  name: string;
  status: string | null;
  avatarUrl: string | null;
}

export interface ContactProfile {
  jid: string;
  pushName: string | null;
  avatarUrl: string | null;
  presence: string | null; // 'available' | 'unavailable' | 'composing' | null
}

export const MAX_NAME_LEN = 25;
export const MAX_STATUS_LEN = 139;
export const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function requireSock() {
  const s = getSock();
  if (!s) throw new Error('WhatsApp socket not connected');
  return s;
}

export async function getMyProfile(): Promise<MyProfile> {
  const sock = requireSock();
  const jid = sock.user?.id ?? '';
  let name = sock.user?.name ?? '';
  let status: string | null = null;
  let avatarUrl: string | null = null;

  try {
    if (jid) {
      const fetched = await sock.fetchStatus(jid);
      const first = Array.isArray(fetched) ? fetched[0] : fetched;
      const s =
        (first as { status?: { status?: string } } | undefined)?.status?.status ??
        (first as { status?: string } | undefined)?.status ??
        null;
      status = typeof s === 'string' ? s : null;
    }
  } catch {
    // status may be hidden / unsupported — leave null.
  }
  try {
    if (jid) avatarUrl = (await sock.profilePictureUrl(jid, 'image')) ?? null;
  } catch {
    avatarUrl = null;
  }

  return { jid, name, status, avatarUrl };
}

export async function updateMyProfile(input: {
  name?: string;
  status?: string;
  avatarBase64?: string;
}): Promise<{ updated: string[] }> {
  const sock = requireSock();
  const updated: string[] = [];

  if (input.name != null) {
    const cleaned = input.name.replace(CONTROL_CHARS_REGEX, '').trim();
    if (cleaned.length === 0 || cleaned.length > MAX_NAME_LEN) {
      throw new Error(`name must be 1-${MAX_NAME_LEN} chars after control-char strip`);
    }
    await sock.updateProfileName(cleaned);
    updated.push('name');
  }
  if (input.status != null) {
    const cleaned = input.status.replace(CONTROL_CHARS_REGEX, '');
    if (cleaned.length > MAX_STATUS_LEN) {
      throw new Error(`status must be ≤ ${MAX_STATUS_LEN} chars`);
    }
    await sock.updateProfileStatus(cleaned);
    updated.push('status');
  }
  if (input.avatarBase64 != null) {
    let buf: Buffer;
    try {
      buf = Buffer.from(input.avatarBase64, 'base64');
    } catch {
      throw new Error('avatar_base64 is not valid base64');
    }
    if (buf.byteLength === 0 || buf.byteLength > 5 * 1024 * 1024) {
      throw new Error('avatar must be 1B..5MB');
    }
    const jid = sock.user?.id ?? '';
    if (!jid) throw new Error('own jid not yet known');
    await sock.updateProfilePicture(jid, buf);
    updated.push('avatar');
  }
  return { updated };
}

export async function getContactProfile(jid: string): Promise<ContactProfile> {
  const sock = requireSock();
  let avatarUrl: string | null = null;
  try {
    avatarUrl = (await sock.profilePictureUrl(jid, 'image')) ?? null;
  } catch {
    avatarUrl = null;
  }
  let pushName: string | null = null;
  try {
    const presenceMap = (sock as unknown as {
      chats?: Map<string, { presences?: Record<string, { lastKnownPresence?: string }> }>;
    }).chats;
    const presences =
      presenceMap?.get(jid)?.presences ?? null;
    if (presences) {
      const first = Object.values(presences)[0];
      if (first?.lastKnownPresence) {
        return { jid, pushName, avatarUrl, presence: first.lastKnownPresence };
      }
    }
  } catch {
    // ignore — presence is best-effort.
  }
  return { jid, pushName, avatarUrl, presence: null };
}
