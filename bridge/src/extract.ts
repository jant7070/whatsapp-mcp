import type { WAMessage, proto } from '@whiskeysockets/baileys';

// Recursively pull a user-visible body string out of a Baileys WAMessage.
// Returns null when the message is purely system / protocol traffic that
// should not appear in chat history (key distribution, ack stubs, reactions,
// etc.). The caller skips null results entirely.

const MAX_BODY_LENGTH = 4096;

// proto.Message.ProtocolMessage.Type enum values relevant to us.
// Baileys ships them as named exports, but values are stable:
//   REVOKE = 0
//   MESSAGE_EDIT = 14
const PROTOCOL_TYPE_REVOKE = 0;

export function extractBody(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  return extractFromMessage(m);
}

function extractFromMessage(m: proto.IMessage): string | null {
  // Plain text variants.
  if (m.conversation) return clip(m.conversation);
  if (m.extendedTextMessage?.text) return clip(m.extendedTextMessage.text);

  // Wrapper variants — recurse one level.
  if (m.ephemeralMessage?.message) return extractFromMessage(m.ephemeralMessage.message);
  if (m.viewOnceMessage?.message) return extractFromMessage(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2?.message) return extractFromMessage(m.viewOnceMessageV2.message);
  if (m.viewOnceMessageV2Extension?.message) return extractFromMessage(m.viewOnceMessageV2Extension.message);
  if (m.editedMessage?.message) return extractFromMessage(m.editedMessage.message);
  if (m.documentWithCaptionMessage?.message) return extractFromMessage(m.documentWithCaptionMessage.message);

  // Edit / revoke / other protocol messages.
  if (m.protocolMessage) {
    const pm = m.protocolMessage;
    if (pm.editedMessage) {
      const inner = extractFromMessage(pm.editedMessage);
      return inner ? `(edited) ${inner}` : null;
    }
    if (pm.type === PROTOCOL_TYPE_REVOKE) return '[message deleted]';
    return null; // key distribution, app-state-sync, history-sync notif, etc.
  }

  // Reactions — render them as a small note rather than a phantom message line.
  // WhatsApp's UI overlays reactions on the original message, which we can't
  // reproduce in flat text. Returning null keeps history clean.
  if (m.reactionMessage) return null;

  // Media placeholders (no bytes — metadata only).
  if (m.imageMessage) return clip(m.imageMessage.caption ? `📷 ${m.imageMessage.caption}` : '📷 Photo');
  if (m.videoMessage) return clip(m.videoMessage.caption ? `🎥 ${m.videoMessage.caption}` : '🎥 Video');
  if (m.audioMessage) return m.audioMessage.ptt ? '🎤 Voice message' : '🔊 Audio';
  if (m.stickerMessage) return '💟 Sticker';
  if (m.documentMessage) return clip(`📄 ${m.documentMessage.fileName ?? 'Document'}`);

  // Other text-bearing variants.
  if (m.contactMessage || m.contactsArrayMessage) return '👤 Contact';
  if (m.locationMessage || m.liveLocationMessage) return '📍 Location';
  if (m.pollCreationMessage || m.pollCreationMessageV3) return '📊 Poll';
  if (m.groupInviteMessage?.caption) return clip(`👥 ${m.groupInviteMessage.caption}`);
  if (m.buttonsMessage?.contentText) return clip(m.buttonsMessage.contentText);
  if (m.listMessage?.description) return clip(m.listMessage.description);
  if (m.templateMessage?.hydratedTemplate?.hydratedContentText) {
    return clip(m.templateMessage.hydratedTemplate.hydratedContentText);
  }

  // senderKeyDistributionMessage / messageContextInfo only carriers — system.
  return null;
}

function clip(s: string): string {
  return s.length > MAX_BODY_LENGTH ? s.slice(0, MAX_BODY_LENGTH) : s;
}
