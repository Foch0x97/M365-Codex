import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@m365-codex/shared';
import { loadConfig, type AppConfig } from '../src/config/index.js';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';
import { SettingsRepository } from '../src/repo/settings.js';
import { buildEnvOverridesFromSettings, SettingsService } from '../src/settings/service.js';
import { testEnv } from './helpers/testApp.js';

/**
 * 设置读写（契约 §2.3）：环境变量显式设置过的项 source=env、editable=false；
 * 其余项存进 settings 表，requires_restart 为真的项进 pending_restart，
 * 只有 logging.log_level 是真正热生效的项。
 */

let db: Database;
let config: AppConfig;
let repo: SettingsRepository;
let service: SettingsService;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  config = loadConfig(testEnv());
  repo = new SettingsRepository(db);
  service = new SettingsService({ repo, config, logger: pino({ level: 'silent' }) });
});

afterEach(() => {
  db.close();
});

describe('默认值', () => {
  it('未被 env 或 db 覆盖的项显示 default 来源，值取自内置默认', () => {
    const view = service.getGroup('tools');
    expect(view.mode).toEqual({ value: 'auto', source: 'default', editable: true, requires_restart: true });
  });
});

describe('env 显式设置', () => {
  it('LOG_LEVEL 被 testEnv 显式设置，因此 source=env 且不可编辑', () => {
    const view = service.getGroup('logging');
    expect(view.log_level?.source).toBe('env');
    expect(view.log_level?.editable).toBe(false);
  });

  it('修改 env 锁定的项被拒绝（403）', () => {
    expect(() => service.patchGroup('logging', { log_level: 'debug' })).toThrow(ApiError);
  });
});

describe('PATCH 落库与读取', () => {
  it('写入后再读取反映 db 来源', () => {
    service.patchGroup('tools', { max_rounds: 5 });
    const view = service.getGroup('tools');
    expect(view.max_rounds).toEqual({ value: 5, source: 'db', editable: true, requires_restart: true });
  });

  it('类型不合法时拒绝，不写库', () => {
    expect(() => service.patchGroup('tools', { max_rounds: 'five' })).toThrow(ApiError);
    expect(service.getGroup('tools').max_rounds?.source).toBe('default');
  });

  it('max_arg_repairs 不能突破协议上限 2', () => {
    expect(() => service.patchGroup('tools', { max_arg_repairs: 5 })).toThrow(ApiError);
  });

  it('未知字段拒绝', () => {
    expect(() => service.patchGroup('tools', { not_a_field: 1 })).toThrow(ApiError);
  });

  it('一次 patch 里一项不合法则整体不生效', () => {
    expect(() =>
      service.patchGroup('tools', { max_rounds: 5, max_calls_per_round: 'nope' }),
    ).toThrow(ApiError);
    expect(service.getGroup('tools').max_rounds?.source).toBe('default');
  });
});

describe('log_level 热生效', () => {
  it('patch 后立刻改变 logger.level，无需重启', () => {
    const logger = pino({ level: 'info' });
    const config2 = loadConfig(testEnv({ LOG_LEVEL: undefined }));
    const svc = new SettingsService({ repo, config: config2, logger });
    svc.patchGroup('logging', { log_level: 'debug' });
    expect(logger.level).toBe('debug');
    expect(svc.getGroup('logging').log_level).toEqual({
      value: 'debug',
      source: 'db',
      editable: true,
      requires_restart: false,
    });
  });
});

describe('pendingRestartEnvVars', () => {
  it('requires_restart 项写库后出现在待重启列表；env 锁定的项不出现', () => {
    service.patchGroup('tools', { max_rounds: 9 });
    const pending = service.pendingRestartEnvVars();
    expect(pending).toContain('TOOLS_MAX_ROUNDS');
    expect(pending).not.toContain('LOG_LEVEL');
  });

  it('写入的值与当前生效值相同时不算 pending', () => {
    service.patchGroup('tools', { max_rounds: config.tools.maxRounds });
    expect(service.pendingRestartEnvVars()).not.toContain('TOOLS_MAX_ROUNDS');
  });
});

describe('buildEnvOverridesFromSettings', () => {
  it('把 db 里的改动合成 env 覆盖层，供下次启动使用', () => {
    service.patchGroup('tools', { max_rounds: 9, allow_parallel: false });
    const overrides = buildEnvOverridesFromSettings(repo, config.envKeysPresent);
    expect(overrides.TOOLS_MAX_ROUNDS).toBe('9');
    expect(overrides.TOOLS_ALLOW_PARALLEL).toBe('false');
  });

  it('env 已显式设置的项不会被覆盖', () => {
    // testEnv 默认设置了 LOG_LEVEL，即便 db 里有 logging.log_level 也不应出现在 overrides
    const overrides = buildEnvOverridesFromSettings(repo, config.envKeysPresent);
    expect(overrides.LOG_LEVEL).toBeUndefined();
  });
});
