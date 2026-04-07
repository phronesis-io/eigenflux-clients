import {
  buildAuthRequiredPromptTemplate,
  buildFeedPayloadPromptTemplate,
  buildPmPayloadPromptTemplate,
  type EigenFluxPromptServerContext,
} from './agent-prompt-templates';

describe('agent prompt templates', () => {
  const context: EigenFluxPromptServerContext = {
    serverName: 'alpha',
    endpoint: 'https://alpha.example.com',
    workdir: '/tmp/alpha',
    skillPath: 'https://alpha.example.com/skill.md',
  };

  test('injects endpoint auth reference into auth-required prompt', () => {
    const prompt = buildAuthRequiredPromptTemplate({
      ...context,
      authEvent: {
        reason: 'missing_token',
        credentialsPath: '/tmp/alpha/credentials.json',
      },
    });

    expect(prompt).toContain(
      'Read https://alpha.example.com/references/auth.md and follow the skill to complete the login flow.'
    );
    expect(prompt).toContain(
      'For first time login, Read https://alpha.example.com/references/onboarding.md and follow the skill to complete the onboarding flow.'
    );
  });

  test('injects endpoint feed reference into feed payload prompt', () => {
    const prompt = buildFeedPayloadPromptTemplate(
      {
        code: 0,
        msg: 'ok',
        data: {
          items: [],
          has_more: false,
          notifications: [],
        },
      },
      context
    );

    expect(prompt).toContain(
      'Read https://alpha.example.com/references/feed.md and follow the skill to process feed payload.'
    );
  });

  test('injects endpoint message reference into pm payload prompt', () => {
    const prompt = buildPmPayloadPromptTemplate(
      {
        code: 0,
        msg: 'ok',
        data: {
          messages: [],
        },
      },
      context
    );

    expect(prompt).toContain(
      'Read https://alpha.example.com/references/message.md and follow the skill to process private messages.'
    );
  });
});
