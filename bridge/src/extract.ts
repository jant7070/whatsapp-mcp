import type { WAMessage, proto } from '@whiskeysockets/baileys';

// Recursively pull a typed metadata record out of a Baileys WAMessage.
//
// Returns:
//   null   — system / protocol traffic; skip silently.
//   object — { text, kind, media?, location?, contact?, poll? }.
//
// `text` is the human-readable preview (kept compatible with the previous
// emoji-prefixed format used for legacy display). Structured fields are also
// surfaced when applicable so the store can populate `media_refs` and
// `message_extras` rows alongside the message itself.

const MAX_BODY_LENGTH = 4096;
const PROTOCOL_TYPE_REVOKE = 0;

export type MessageKind =
  | 'text'
  | 'image'
  | 'document'
  | 'video'
  | 'audio'
  | 'voice'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'poll'
  | 'edit'
  | 'delete'
  | 'reaction'
  | 'unknown';

export interface MediaMeta {
  kind: 'image' | 'document' | 'video' | 'audio' | 'voice' | 'sticker';
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
  caption?: string;
}

export interface LocationPayload {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
  isLive?: boolean;
}

export interface ContactPayload {
  displayName?: string;
  vcard?: string;
  contacts?: { displayName?: string; vcard?: string }[];
}

export interface PollPayload {
  name: string;
  options: string[];
  selectableCount?: number;
}

export interface ReactionPayload {
  text: string;
  targetMessageId: string | null;
}

export interface EditPayload {
  targetMessageId: string | null;
  newText: string;
}

export interface ExtractResult {
  text: string;
  kind: MessageKind;
  media?: MediaMeta;
  location?: LocationPayload;
  contact?: ContactPayload;
  poll?: PollPayload;
  reaction?: ReactionPayload;
  edit?: EditPayload;
  // The raw IMessage that owns the media payload (used for downloadMediaMessage).
  // Only populated when `media` is set.
  mediaSource?: proto.IMessage;
}

export function extractBody(msg: WAMessage): string | null {
  const result = extractMeta(msg);
  return result?.text ?? null;
}

export function extractMeta(msg: WAMessage): ExtractResult | null {
  const m = msg.message;
  if (!m) return null;
  return extractFromMessage(m);
}

function extractFromMessage(m: proto.IMessage): ExtractResult | null {
  // Plain text variants.
  if (m.conversation) return ok(clip(m.conversation), 'text');
  if (m.extendedTextMessage?.text) return ok(clip(m.extendedTextMessage.text), 'text');

  // Wrapper variants — recurse one level.
  if (m.ephemeralMessage?.message) return extractFromMessage(m.ephemeralMessage.message);
  if (m.viewOnceMessage?.message) return extractFromMessage(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2?.message) return extractFromMessage(m.viewOnceMessageV2.message);
  if (m.viewOnceMessageV2Extension?.message)
    return extractFromMessage(m.viewOnceMessageV2Extension.message);
  if (m.editedMessage?.message) return extractFromMessage(m.editedMessage.message);
  if (m.documentWithCaptionMessage?.message)
    return extractFromMessage(m.documentWithCaptionMessage.message);

  // Edit / revoke / other protocol messages.
  if (m.protocolMessage) {
    const pm = m.protocolMessage;
    if (pm.editedMessage) {
      const inner = extractFromMessage(pm.editedMessage);
      const text = inner?.text ? `(edited) ${inner.text}` : null;
      if (!text) return null;
      return {
        text,
        kind: 'edit',
        edit: { targetMessageId: pm.key?.id ?? null, newText: inner?.text ?? '' },
      };
    }
    if (pm.type === PROTOCOL_TYPE_REVOKE) {
      return {
        text: '[message deleted]',
        kind: 'delete',
        edit: { targetMessageId: pm.key?.id ?? null, newText: '[message deleted]' },
      };
    }
    return null;
  }

  // Reactions: surface a structured record but no text — caller decides whether
  // to insert a row. (insertMessage requires a body; reactions return null.)
  if (m.reactionMessage) {
    return {
      text: '',
      kind: 'reaction',
      reaction: {
        text: m.reactionMessage.text ?? '',
        targetMessageId: m.reactionMessage.key?.id ?? null,
      },
    };
  }

  // Media variants.
  if (m.imageMessage) {
    const caption = m.imageMessage.caption ?? '';
    return {
      text: clip(caption ? `📷 ${caption}` : '📷 Photo'),
      kind: 'image',
      media: {
        kind: 'image',
        mimeType: m.imageMessage.mimetype ?? undefined,
        fileSize: numericSize(m.imageMessage.fileLength),
        caption: caption || undefined,
      },
      mediaSource: m,
    };
  }
  if (m.videoMessage) {
    const caption = m.videoMessage.caption ?? '';
    return {
      text: clip(caption ? `🎥 ${caption}` : '🎥 Video'),
      kind: 'video',
      media: {
        kind: 'video',
        mimeType: m.videoMessage.mimetype ?? undefined,
        fileSize: numericSize(m.videoMessage.fileLength),
        caption: caption || undefined,
      },
      mediaSource: m,
    };
  }
  if (m.audioMessage) {
    const isVoice = !!m.audioMessage.ptt;
    return {
      text: isVoice ? '🎤 Voice message' : '🔊 Audio',
      kind: isVoice ? 'voice' : 'audio',
      media: {
        kind: isVoice ? 'voice' : 'audio',
        mimeType: m.audioMessage.mimetype ?? undefined,
        fileSize: numericSize(m.audioMessage.fileLength),
      },
      mediaSource: m,
    };
  }
  if (m.stickerMessage) {
    return {
      text: '💟 Sticker',
      kind: 'sticker',
      media: {
        kind: 'sticker',
        mimeType: m.stickerMessage.mimetype ?? undefined,
        fileSize: numericSize(m.stickerMessage.fileLength),
      },
      mediaSource: m,
    };
  }
  if (m.documentMessage) {
    const fn = m.documentMessage.fileName ?? 'Document';
    return {
      text: clip(`📄 ${fn}`),
      kind: 'document',
      media: {
        kind: 'document',
        mimeType: m.documentMessage.mimetype ?? undefined,
        fileName: fn,
        fileSize: numericSize(m.documentMessage.fileLength),
        caption: m.documentMessage.caption ?? undefined,
      },
      mediaSource: m,
    };
  }

  // Extras — location.
  if (m.locationMessage || m.liveLocationMessage) {
    const isLive = !!m.liveLocationMessage;
    const loc = (m.locationMessage ?? m.liveLocationMessage) as
      | (proto.Message.ILocationMessage & { name?: string | null; address?: string | null })
      | null
      | undefined;
    return {
      text: '📍 Location',
      kind: 'location',
      location: {
        latitude: Number(loc?.degreesLatitude ?? 0),
        longitude: Number(loc?.degreesLongitude ?? 0),
        name: loc?.name ?? undefined,
        address: loc?.address ?? undefined,
        isLive,
      },
    };
  }

  // Extras — contact.
  if (m.contactMessage) {
    return {
      text: '👤 Contact',
      kind: 'contact',
      contact: {
        displayName: m.contactMessage.displayName ?? undefined,
        vcard: m.contactMessage.vcard ?? undefined,
      },
    };
  }
  if (m.contactsArrayMessage) {
    return {
      text: '👤 Contact',
      kind: 'contact',
      contact: {
        displayName: m.contactsArrayMessage.displayName ?? undefined,
        contacts: (m.contactsArrayMessage.contacts ?? []).map((c) => ({
          displayName: c.displayName ?? undefined,
          vcard: c.vcard ?? undefined,
        })),
      },
    };
  }

  // Extras — poll.
  const poll = m.pollCreationMessage || m.pollCreationMessageV3;
  if (poll) {
    return {
      text: '📊 Poll',
      kind: 'poll',
      poll: {
        name: poll.name ?? '',
        options: (poll.options ?? []).map((o) => o.optionName ?? ''),
        selectableCount: poll.selectableOptionsCount ?? undefined,
      },
    };
  }

  // Other text-bearing variants.
  if (m.groupInviteMessage?.caption) return ok(clip(`👥 ${m.groupInviteMessage.caption}`), 'text');
  if (m.buttonsMessage?.contentText) return ok(clip(m.buttonsMessage.contentText), 'text');
  if (m.listMessage?.description) return ok(clip(m.listMessage.description), 'text');
  if (m.templateMessage?.hydratedTemplate?.hydratedContentText) {
    return ok(clip(m.templateMessage.hydratedTemplate.hydratedContentText), 'text');
  }

  return null;
}

function ok(text: string, kind: MessageKind): ExtractResult {
  return { text, kind };
}

function clip(s: string): string {
  return s.length > MAX_BODY_LENGTH ? s.slice(0, MAX_BODY_LENGTH) : s;
}

function numericSize(t: unknown): number | undefined {
  if (t == null) return undefined;
  if (typeof t === 'number') return t;
  const maybeLong = t as { toNumber?: () => number };
  if (typeof maybeLong.toNumber === 'function') {
    try {
      return maybeLong.toNumber();
    } catch {
      return undefined;
    }
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}
