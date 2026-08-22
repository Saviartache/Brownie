import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, resolveConfig } from '../src/core/config/Config.js';
import { LogLevel } from '../src/core/logging/Logger.js';

const SECRET = 'a'.repeat(64);

describe('resolveConfig', () => {
  it('runs on defaults alone', () => {
    const config = resolveConfig();
    expect(config.proxy).toEqual(DEFAULT_CONFIG.proxy);
    expect(config.servers.allow).toEqual([]);
    expect(config.logging.level).toBe(LogLevel.Info);
  });

  it('takes the file over the defaults, and the environment over the file', () => {
    const config = resolveConfig({
      file: { proxy: { host: '0.0.0.0', port: 3000 }, logging: { level: 'debug' } },
      env: { BROWNIE_PROXY_PORT: '4000' },
    });
    expect(config.proxy).toEqual({ host: '0.0.0.0', port: 4000 });
    expect(config.logging.level).toBe(LogLevel.Debug);
  });

  it('ignores an empty environment value rather than treating it as a choice', () => {
    const config = resolveConfig({
      file: { proxy: { host: '10.0.0.1' } },
      env: { BROWNIE_PROXY_HOST: '   ' },
    });
    expect(config.proxy.host).toBe('10.0.0.1');
  });

  describe('the native module', () => {
    it('is off when no secret is configured, rather than on and unable to authenticate', () => {
      expect(resolveConfig().native.enabled).toBe(false);
    });

    it('is on as soon as a usable secret exists', () => {
      const config = resolveConfig({ env: { BROWNIE_NATIVE_SECRET: SECRET } });
      expect(config.native.enabled).toBe(true);
      expect(config.native.secretHex).toBe(SECRET);
    });

    it('refuses a secret too short or not hex', () => {
      expect(() => resolveConfig({ env: { BROWNIE_NATIVE_SECRET: 'abcd' } })).toThrow(
        /at least 32 hex characters/,
      );
      expect(() => resolveConfig({ file: { native: { secret: 'z'.repeat(64) } } })).toThrow(
        ConfigError,
      );
    });
  });

  describe('rejects a configuration that could only fail later', () => {
    it('a port that is not a port', () => {
      expect(() => resolveConfig({ file: { proxy: { port: 70000 } } })).toThrow(/proxy.port/);
      expect(() => resolveConfig({ file: { proxy: { port: 'nope' } } })).toThrow(/proxy.port/);
      expect(() => resolveConfig({ file: { proxy: { port: 1.5 } } })).toThrow(ConfigError);
    });

    it('a host list that is not a list of hosts', () => {
      expect(() => resolveConfig({ file: { servers: { allow: 'one' } } })).toThrow(
        /servers.allow must be an array/,
      );
      expect(() => resolveConfig({ file: { servers: { allow: [''] } } })).toThrow(
        /servers.allow\[0\]/,
      );
    });

    it('a section that is not an object', () => {
      expect(() => resolveConfig({ file: { proxy: 'nope' } })).toThrow(/proxy must be an object/);
      expect(() => resolveConfig({ file: [] })).toThrow(ConfigError);
    });

    it('a value of the wrong type', () => {
      expect(() => resolveConfig({ file: { plugins: { directory: 5 } } })).toThrow(
        /plugins.directory must be a string/,
      );
    });
  });

  it('falls back to info for a log level it does not know, rather than going silent', () => {
    expect(resolveConfig({ env: { BROWNIE_LOG_LEVEL: 'shout' } }).logging.level).toBe(
      LogLevel.Info,
    );
    expect(resolveConfig({ env: { BROWNIE_LOG_LEVEL: 'off' } }).logging.level).toBe(LogLevel.Off);
  });

  it('writes no log file unless one was asked for', () => {
    // A runtime that leaves a file behind nobody asked for is the same mistake
    // as one that writes a packet capture into whatever directory it started in.
    expect(resolveConfig({}).logging.file).toBe('');
    expect(resolveConfig({ env: { BROWNIE_LOG_FILE: 'logs/runtime.log' } }).logging.file).toBe(
      'logs/runtime.log',
    );
    expect(resolveConfig({ file: { logging: { file: 'from-config.log' } } }).logging.file).toBe(
      'from-config.log',
    );
  });

  it('is frozen, so nothing can change it under a running subsystem', () => {
    const config = resolveConfig();
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.proxy)).toBe(true);
  });
});
