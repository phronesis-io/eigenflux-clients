import { normalizeReplyTarget } from './reply-target';

describe('normalizeReplyTarget channel matrix', () => {
  // Expectations are derived from the audited OpenClaw routing/target grammar:
  // - .audit/openclaw/src/infra/outbound/outbound-session.test.ts
  // - .audit/openclaw/src/channels/plugins/target-parsing.test.ts
  // - .audit/openclaw/src/channels/plugins/normalize/whatsapp.ts
  test.each([
    {
      name: 'feishu direct open_id legacy target',
      channel: 'feishu',
      sessionKey: 'agent:main:feishu:direct:ou_user_123',
      raw: 'ou_user_123',
      expected: 'user:ou_user_123',
    },
    {
      name: 'feishu direct chat_id target keeps chat semantics',
      channel: 'feishu',
      sessionKey: 'agent:main:feishu:direct:oc_dm_chat',
      raw: 'oc_dm_chat',
      expected: 'chat:oc_dm_chat',
    },
    {
      name: 'feishu group chat_id legacy target',
      channel: 'feishu',
      sessionKey: 'agent:main:feishu:group:oc_group_chat',
      raw: 'oc_group_chat',
      expected: 'chat:oc_group_chat',
    },
    {
      name: 'discord direct target',
      channel: 'discord',
      sessionKey: 'agent:main:discord:direct:123',
      raw: '123',
      expected: 'user:123',
    },
    {
      name: 'discord channel target',
      channel: 'discord',
      sessionKey: 'agent:main:discord:channel:456',
      raw: '456',
      expected: 'channel:456',
    },
    {
      name: 'telegram direct numeric target',
      channel: 'telegram',
      sessionKey: 'agent:main:telegram:direct:123456789',
      raw: '123456789',
      expected: '123456789',
    },
    {
      name: 'telegram direct username target',
      channel: 'telegram',
      sessionKey: 'agent:main:telegram:direct:@alice',
      raw: '@alice',
      expected: '@alice',
    },
    {
      name: 'telegram account-scoped direct target',
      channel: 'telegram',
      sessionKey: 'agent:main:telegram:tasks:direct:7550356539',
      raw: '7550356539',
      expected: '7550356539',
    },
    {
      name: 'telegram group target',
      channel: 'telegram',
      sessionKey: 'agent:main:telegram:group:-100123456',
      raw: '-100123456',
      expected: '-100123456',
    },
    {
      name: 'whatsapp direct e164 target',
      channel: 'whatsapp',
      sessionKey: 'agent:main:whatsapp:direct:+15551234567',
      raw: '+15551234567',
      expected: '+15551234567',
    },
    {
      name: 'whatsapp group jid target',
      channel: 'whatsapp',
      sessionKey: 'agent:main:whatsapp:group:120363040000000000@g.us',
      raw: '120363040000000000@g.us',
      expected: '120363040000000000@g.us',
    },
  ])('$name', ({ channel, sessionKey, raw, expected }) => {
    expect(
      normalizeReplyTarget(raw, {
        channel,
        sessionKey,
      })
    ).toBe(expected);
  });

  test.each([
    {
      name: 'telegram sender fallback stays raw',
      channel: 'telegram',
      raw: '123456789',
      expected: '123456789',
    },
    {
      name: 'whatsapp sender fallback stays raw',
      channel: 'whatsapp',
      raw: '+15551234567',
      expected: '+15551234567',
    },
    {
      name: 'discord sender fallback uses user prefix',
      channel: 'discord',
      raw: '123',
      expected: 'user:123',
    },
  ])('$name', ({ channel, raw, expected }) => {
    expect(
      normalizeReplyTarget(raw, {
        channel,
        fallbackKind: 'user',
      })
    ).toBe(expected);
  });
});
