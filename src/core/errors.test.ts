import { describe, it, expect } from 'vitest';
import { BlockedReason, isBlockedReason } from './errors.js';

describe('core/errors', () => {
  describe('BlockedReason', () => {
    it('defines all required blocked reasons', () => {
      expect(BlockedReason.NOT_LOGGED_IN).toBe('not_logged_in');
      expect(BlockedReason.TARGET_UNRESOLVED).toBe('target_unresolved');
      expect(BlockedReason.LISTEN_DISCONNECTED).toBe('listen_disconnected');
      expect(BlockedReason.DAEMON_UNAVAILABLE).toBe('daemon_unavailable');
      expect(BlockedReason.SEND_FAILED).toBe('send_failed');
      expect(BlockedReason.DISABLED).toBe('disabled');
    });
  });

  describe('isBlockedReason()', () => {
    it('returns true for valid blocked reasons', () => {
      expect(isBlockedReason('not_logged_in')).toBe(true);
      expect(isBlockedReason('disabled')).toBe(true);
    });

    it('returns false for invalid reasons', () => {
      expect(isBlockedReason('unknown')).toBe(false);
      expect(isBlockedReason('')).toBe(false);
    });
  });
});
