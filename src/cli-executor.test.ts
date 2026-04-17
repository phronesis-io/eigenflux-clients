import { execEigenflux } from './cli-executor';

describe('execEigenflux', () => {
  test('returns not_installed when the binary cannot be spawned (ENOENT)', async () => {
    const result = await execEigenflux(
      '/tmp/definitely-not-a-real-binary-eigenflux-xyz',
      ['server', 'list', '--format', 'json']
    );
    expect(result.kind).toBe('not_installed');
    if (result.kind === 'not_installed') {
      expect(result.bin).toBe('/tmp/definitely-not-a-real-binary-eigenflux-xyz');
    }
  });
});
