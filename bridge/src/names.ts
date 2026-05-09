import { allContacts, getChat, getContact, listChats, type ContactRecord } from './store';
import { isLidJid, lidToPhoneJid } from './lidStore';

// Render a JID as +<digits> when no human-readable name is available.
// Strips any device suffix like ":12" that appears on participant JIDs.
//
// `@lid` JIDs get special handling: the local-part of a Linked Identifier
// is NOT a phone number, so formatting it as one would lie. We try to
// resolve via the LID store first; if no mapping exists, we render a
// neutral placeholder rather than fake +digits.
export function formatPhoneFallback(jid: string): string {
  if (isLidJid(jid)) {
    const phoneJid = lidToPhoneJid(jid);
    if (phoneJid) return formatPhoneFallback(phoneJid);
    return '(linked id, phone unknown)';
  }
  const local = jid.split('@')[0] || jid;
  const digits = local.split(':')[0]!.replace(/[^0-9]/g, '');
  return digits ? `+${digits}` : jid;
}

export function bestContactName(c: ContactRecord | undefined): string {
  if (!c) return '';
  return c.name || c.pushName || '';
}

// Resolve a chat JID to a display name. Falls through:
//   group subject  →  saved contact name  →  pushName  →  phone fallback (+digits)
export function resolveChatName(jid: string): string {
  const chat = getChat(jid);
  if (chat?.isGroup) {
    return chat.name || formatPhoneFallback(jid);
  }
  const fromContacts = bestContactName(getContact(jid));
  return chat?.name || fromContacts || formatPhoneFallback(jid);
}

export interface ChatSearchHit {
  jid: string;
  name: string;
  isGroup: boolean;
  lastTimestamp: number;
}

// Case-insensitive substring search over saved contact names, pushNames, and
// group subjects. Newest-first by chat recency.
export function searchChatsByName(
  query: string,
  limit: number,
  isChatListJid: (jid: string) => boolean,
): ChatSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const seen = new Map<string, ChatSearchHit>();

  const consider = (jid: string, name: string) => {
    if (!jid || !name || !isChatListJid(jid) || seen.has(jid)) return;
    if (!name.toLowerCase().includes(q)) return;
    const chat = getChat(jid);
    seen.set(jid, {
      jid,
      name: resolveChatName(jid),
      isGroup: jid.endsWith('@g.us'),
      lastTimestamp: chat?.lastTimestamp ?? 0,
    });
  };

  // We don't have a direct "iterate chats" export to keep the store surface
  // small — iterate contacts first, then ask the chat side via resolveChatName.
  for (const c of allContacts()) {
    consider(c.jid, c.name);
    consider(c.jid, c.pushName);
  }

  for (const c of listChats(2000)) consider(c.jid, c.name);

  return Array.from(seen.values())
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    .slice(0, limit);
}
