import { describe, it, expect } from 'vitest';
import * as proc from './proc.js';

describe('platform/proc', () => {
  describe('run()', () => {
    it('executes a command and returns stdout', async () => {
      const result = await proc.run(['echo', 'hello']);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('hello');
    });

    it('returns non-zero exit code on failure', async () => {
      const result = await proc.run(['sh', '-c', 'exit 42']);
      expect(result.code).toBe(42);
    });

    it('handles UTF-8 output correctly', async () => {
      const result = await proc.run(['echo', '中文测试']);
      expect(result.stdout.trim()).toBe('中文测试');
    });

    it('does not use shell', async () => {
      // If shell were used, this would succeed; without shell, it should fail
      const result = await proc.run(['echo $HOME']);
      expect(result.code).not.toBe(0);
    });
  });
});
