import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb, truncateAll } from '../src/db';
import { getChat } from '../src/store';
import { refreshGroupSubjects } from '../src/baileys';

beforeEach(() => {
  initDb({ path: ':memory:' });
  truncateAll();
});
afterEach(() => closeDb());

describe('refreshGroupSubjects', () => {
  it('writes subjects for every group returned by groupFetchAllParticipating', async () => {
    const fakeSock = {
      groupFetchAllParticipating: async () => ({
        '120363111@g.us': { id: '120363111@g.us', subject: 'El conter' },
        '120363222@g.us': { id: '120363222@g.us', subject: 'Banesco vacantes' },
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await refreshGroupSubjects(fakeSock as any);
    expect(out.refreshed).toBe(2);
    expect(getChat('120363111@g.us')?.name).toBe('El conter');
    expect(getChat('120363222@g.us')?.name).toBe('Banesco vacantes');
  });

  it('skips entries with missing or empty subject', async () => {
    const fakeSock = {
      groupFetchAllParticipating: async () => ({
        '120363333@g.us': { id: '120363333@g.us', subject: '' },
        '120363444@g.us': { id: '120363444@g.us' /* no subject */ },
        '120363555@g.us': { id: '120363555@g.us', subject: 'Real group' },
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await refreshGroupSubjects(fakeSock as any);
    expect(out.refreshed).toBe(1);
    expect(getChat('120363333@g.us')).toBeUndefined();
    expect(getChat('120363444@g.us')).toBeUndefined();
    expect(getChat('120363555@g.us')?.name).toBe('Real group');
  });

  it('returns refreshed=0 and swallows errors', async () => {
    const fakeSock = {
      groupFetchAllParticipating: async () => {
        throw new Error('socket gone');
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await refreshGroupSubjects(fakeSock as any);
    expect(out.refreshed).toBe(0);
  });
});
