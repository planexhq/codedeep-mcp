import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('logger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('log.error writes to stderr with [codedeep-mcp error] prefix', async () => {
    const { log } = await import('../src/logger.js');

    log.error('boom');

    expect(stderrSpy).toHaveBeenCalledWith('[codedeep-mcp error] boom\n');
  });

  it('log.warn writes to stderr with [codedeep-mcp warn] prefix', async () => {
    const { log } = await import('../src/logger.js');

    log.warn('careful');

    expect(stderrSpy).toHaveBeenCalledWith('[codedeep-mcp warn] careful\n');
  });

  it('log.debug is a no-op when CODEDEEP_DEBUG is unset', async () => {
    vi.stubEnv('CODEDEEP_DEBUG', '');
    vi.resetModules();
    const { log } = await import('../src/logger.js');

    log.debug('quiet please');

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('log.debug writes when CODEDEEP_DEBUG=1 is set before module load', async () => {
    vi.stubEnv('CODEDEEP_DEBUG', '1');
    vi.resetModules();
    const { log } = await import('../src/logger.js');

    log.debug('chatty');

    expect(stderrSpy).toHaveBeenCalledWith('[codedeep-mcp debug] chatty\n');
  });
});
