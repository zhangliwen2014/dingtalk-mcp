export const BlockedReason = {
  NOT_LOGGED_IN: 'not_logged_in',
  TARGET_UNRESOLVED: 'target_unresolved',
  LISTEN_DISCONNECTED: 'listen_disconnected',
  DAEMON_UNAVAILABLE: 'daemon_unavailable',
  SEND_FAILED: 'send_failed',
  DISABLED: 'disabled'
} as const;

export type BlockedReason = (typeof BlockedReason)[keyof typeof BlockedReason];

export function isBlockedReason(value: string): value is BlockedReason {
  return Object.values(BlockedReason).includes(value as BlockedReason);
}
