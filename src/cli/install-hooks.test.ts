import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mergeHooks, installHooksFile, DTMCP_HOOK_COMMAND } from './install-hooks.js';

const DTMCP_EVENTS = [
  'SessionStart',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SessionEnd',
];

describe('cli/install-hooks', () => {
  describe('mergeHooks', () => {
    it('adds all five dtmcp hook events to an empty object', () => {
      const result = mergeHooks({});

      for (const event of DTMCP_EVENTS) {
        expect(result[event]).toBeDefined();
      }

      const postToolUse = result['PostToolUse'] as Array<Record<string, unknown>>;
      expect(postToolUse[0]).toEqual({
        matcher: '*',
        hooks: [{ type: 'command', command: DTMCP_HOOK_COMMAND }],
      });

      const stop = result['Stop'] as Array<Record<string, unknown>>;
      expect(stop[0]).toEqual({
        hooks: [{ type: 'command', command: DTMCP_HOOK_COMMAND }],
      });
    });

    it('preserves unrelated user hooks', () => {
      const existing = {
        PostToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'other-tool hook' }],
          },
        ],
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'keep-me' }],
          },
        ],
      };

      const result = mergeHooks(existing);

      expect(result['PreToolUse']).toEqual(existing['PreToolUse']);
      const post = result['PostToolUse'] as Array<Record<string, unknown>>;
      expect(post).toHaveLength(2);
      expect(post[0]).toEqual(existing['PostToolUse'][0]);
      expect(post[1]).toEqual({
        matcher: '*',
        hooks: [{ type: 'command', command: DTMCP_HOOK_COMMAND }],
      });
    });

    it('is idempotent: installing twice yields the same config', () => {
      const once = mergeHooks({});
      const twice = mergeHooks(once);
      expect(twice).toEqual(once);
    });

    it('replaces a stale dtmcp entry with different command placement', () => {
      const stale = {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'old-dtmcp hook' },
              { type: 'command', command: 'user-hook' },
            ],
          },
          {
            matcher: 'x',
            hooks: [{ type: 'command', command: 'dtmcp hook' }],
          },
        ],
      };

      const result = mergeHooks(stale, 'old-dtmcp hook');

      const stop = result['Stop'] as Array<Record<string, unknown>>;
      expect(stop).toHaveLength(2);
      expect(stop[0]).toEqual({
        hooks: [{ type: 'command', command: 'user-hook' }],
      });
      expect(stop[1]).toEqual({
        hooks: [{ type: 'command', command: 'old-dtmcp hook' }],
      });
    });

    it('drops entries left empty after removing dtmcp hooks', () => {
      const existing = {
        Stop: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'dtmcp hook' }],
          },
        ],
      };

      const result = mergeHooks(existing);
      const stop = result['Stop'] as Array<Record<string, unknown>>;
      expect(stop).toHaveLength(1);
      expect(stop[0]).toEqual({
        hooks: [{ type: 'command', command: 'dtmcp hook' }],
      });
    });
  });

  describe('installHooksFile', () => {
    let tempDir: string;
    let settingsPath: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtmcp-hooks-'));
      settingsPath = path.join(tempDir, 'settings.json');
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('creates settings.json with hooks when file does not exist', () => {
      installHooksFile(settingsPath);

      const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(written['hooks']['Stop']).toBeDefined();
    });

    it('preserves all other top-level settings keys', () => {
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          permissions: { trustDirectories: ['/some/dir'] },
          model: { name: 'qfmodel' },
          mcpServers: { dingtalk: { command: 'node' } },
        })
      );

      installHooksFile(settingsPath);

      const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(written['permissions']).toEqual({ trustDirectories: ['/some/dir'] });
      expect(written['model']).toEqual({ name: 'qfmodel' });
      expect(written['mcpServers']).toEqual({ dingtalk: { command: 'node' } });
      expect(written['hooks']).toBeDefined();
    });

    it('running twice produces identical file content', () => {
      installHooksFile(settingsPath);
      const first = fs.readFileSync(settingsPath, 'utf8');
      installHooksFile(settingsPath);
      const second = fs.readFileSync(settingsPath, 'utf8');
      expect(second).toBe(first);
    });

    it('backslashes up before overwriting an existing file', () => {
      fs.writeFileSync(settingsPath, JSON.stringify({ model: { name: 'x' } }));

      installHooksFile(settingsPath);

      const backups = fs.readdirSync(tempDir).filter((f) => f.startsWith('settings.json.bak'));
      expect(backups.length).toBe(1);
      const backupContent = JSON.parse(
        fs.readFileSync(path.join(tempDir, backups[0]), 'utf8')
      );
      expect(backupContent).toEqual({ model: { name: 'x' } });
    });
  });
});
