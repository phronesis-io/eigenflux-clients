describe('PLUGIN_CONFIG polling interval', () => {
  const originalValue = process.env.EIGENFLUX_POLL_INTERVAL;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.EIGENFLUX_POLL_INTERVAL;
    } else {
      process.env.EIGENFLUX_POLL_INTERVAL = originalValue;
    }
    jest.resetModules();
  });

  test('uses seconds-based polling interval env var', async () => {
    process.env.EIGENFLUX_POLL_INTERVAL = '45';
    jest.resetModules();

    const { PLUGIN_CONFIG } = await import('./config');

    expect(PLUGIN_CONFIG.POLL_INTERVAL_SEC).toBe(45);
  });

  test('falls back to 5 minutes for invalid values', async () => {
    process.env.EIGENFLUX_POLL_INTERVAL = '0';
    jest.resetModules();

    const { PLUGIN_CONFIG } = await import('./config');

    expect(PLUGIN_CONFIG.POLL_INTERVAL_SEC).toBe(300);
  });
});

describe('PLUGIN_CONFIG USER_AGENT', () => {
  afterEach(() => {
    jest.resetModules();
  });

  test('includes eigenflux plugin version', async () => {
    jest.resetModules();
    const { PLUGIN_CONFIG } = await import('./config');

    expect(PLUGIN_CONFIG.USER_AGENT).toContain('eigenflux-plugin');
    expect(PLUGIN_CONFIG.USER_AGENT).toContain('node/');
    expect(PLUGIN_CONFIG.USER_AGENT).toMatch(/\(.*;\s*.*;\s*.*\)/); // (platform; arch; release)
    expect(PLUGIN_CONFIG.PLUGIN_VERSION).toBe('0.0.1-alpha.0');
  });
});
