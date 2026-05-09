// Storage layer round-trip + edit/delete reflection.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb, truncateAll } from '../src/db';
import {
  getMessage,
  getMessages,
  insertMessage,
  listChats,
  markMessageDeleted,
  updateMessageBody,
  upsertChat,
  counts,
} from '../src/store';

beforeEach(() => {
  initDb({ path: ':memory:' });
  truncateAll();
});
afterEach(() => closeDb());

describe('store (sqlite)', () => {
  it('inserts and retrieves messages newest-first', () => {
    upsertChat({ jid: 'a@s.whatsapp.net', name: 'A', isGroup: false, lastTimestamp: 0, lastMessage: '' });
    insertMessage({
      id: '1',
      chatJid: 'a@s.whatsapp.net',
      sender: 'a@s.whatsapp.net',
      fromName: 'A',
      body: 'hello',
      timestamp: 100,
      isGroup: false,
      isFromMe: false,
      messageKind: 'text',
    });
    insertMessage({
      id: '2',
      chatJid: 'a@s.whatsapp.net',
      sender: 'a@s.whatsapp.net',
      fromName: 'A',
      body: 'world',
      timestamp: 200,
      isGroup: false,
      isFromMe: false,
      messageKind: 'text',
    });
    const msgs = getMessages('a@s.whatsapp.net', 10);
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.id).toBe('2');
    expect(msgs[1]!.id).toBe('1');
  });

  it('rejects duplicate inserts', () => {
    insertMessage({
      id: '1', chatJid: 'a@s.whatsapp.net', sender: 'a', fromName: '', body: 'x',
      timestamp: 1, isGroup: false, isFromMe: false, messageKind: 'text',
    });
    const second = insertMessage({
      id: '1', chatJid: 'a@s.whatsapp.net', sender: 'a', fromName: '', body: 'x',
      timestamp: 1, isGroup: false, isFromMe: false, messageKind: 'text',
    });
    expect(second).toBe(false);
  });

  it('reflects edits via updateMessageBody', () => {
    insertMessage({
      id: '1', chatJid: 'a@s.whatsapp.net', sender: 'a', fromName: '', body: 'orig',
      timestamp: 1, isGroup: false, isFromMe: true, messageKind: 'text',
    });
    updateMessageBody('a@s.whatsapp.net', '1', 'edited body', 999);
    const m = getMessage('a@s.whatsapp.net', '1');
    expect(m?.body).toBe('edited body');
    expect(m?.editedAt).toBe(999);
  });

  it('reflects deletes via markMessageDeleted', () => {
    insertMessage({
      id: '1', chatJid: 'a@s.whatsapp.net', sender: 'a', fromName: '', body: 'orig',
      timestamp: 1, isGroup: false, isFromMe: true, messageKind: 'text',
    });
    markMessageDeleted('a@s.whatsapp.net', '1', 1234);
    const m = getMessage('a@s.whatsapp.net', '1');
    expect(m?.deletedAt).toBe(1234);
    expect(m?.body).toBe('[message deleted]');
  });

  it('listChats orders by recency', () => {
    upsertChat({ jid: 'a@s.whatsapp.net', name: 'A', isGroup: false, lastTimestamp: 100, lastMessage: '' });
    upsertChat({ jid: 'b@s.whatsapp.net', name: 'B', isGroup: false, lastTimestamp: 200, lastMessage: '' });
    const chats = listChats(10);
    expect(chats[0]!.jid).toBe('b@s.whatsapp.net');
  });

  it('counts reflects current row counts', () => {
    upsertChat({ jid: 'a@s.whatsapp.net', name: 'A', isGroup: false, lastTimestamp: 0, lastMessage: '' });
    insertMessage({
      id: '1', chatJid: 'a@s.whatsapp.net', sender: 'a', fromName: '', body: 'x',
      timestamp: 1, isGroup: false, isFromMe: false, messageKind: 'text',
    });
    const c = counts();
    expect(c.chats).toBe(1);
    expect(c.messages).toBe(1);
  });
});
