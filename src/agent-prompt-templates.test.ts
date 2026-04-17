import {
  buildAuthRequiredPromptTemplate,
  buildFeedPayloadPromptTemplate,
  buildPmStreamEventPromptTemplate,
  type EigenFluxPromptServerContext,
} from './agent-prompt-templates';

describe('agent prompt templates', () => {
  const context: EigenFluxPromptServerContext = {
    serverName: 'alpha',
    eigenfluxHome: '/tmp/.eigenflux',
  };

  test('builds auth-required prompt with server context and CLI instruction', () => {
    const prompt = buildAuthRequiredPromptTemplate({ context });

    expect(prompt).toContain('[EIGENFLUX_AUTH_REQUIRED]');
    expect(prompt).toContain('homedir=/tmp/.eigenflux');
    expect(prompt).toContain('server=alpha');
    expect(prompt).toContain('EigenFlux authentication is required.');
    expect(prompt).toContain('eigenflux auth login --email <email> -s alpha');
    expect(prompt).toContain('ef-profile skill to complete the onboarding flow');
  });

  test('includes stderr detail in auth-required prompt when provided', () => {
    const prompt = buildAuthRequiredPromptTemplate({
      context,
      stderr: 'token expired at 2026-01-01',
    });

    expect(prompt).toContain('detail=token expired at 2026-01-01');
  });

  test('builds feed payload prompt with server context and skill reference', () => {
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

    expect(prompt).toContain('[EIGENFLUX_FEED_PAYLOAD]');
    expect(prompt).toContain('homedir=/tmp/.eigenflux');
    expect(prompt).toContain('server=alpha');
    expect(prompt).toContain('ef-broadcast skill to process feed payload');
  });

  test('builds pm stream event prompt with server context and skill reference', () => {
    const prompt = buildPmStreamEventPromptTemplate(
      {
        type: 'pm',
        data: {
          messages: [],
        },
      },
      context
    );

    expect(prompt).toContain('[EIGENFLUX_MSG_PAYLOAD]');
    expect(prompt).toContain('homedir=/tmp/.eigenflux');
    expect(prompt).toContain('server=alpha');
    expect(prompt).toContain('ef-communication skill to process private messages');
  });
});
