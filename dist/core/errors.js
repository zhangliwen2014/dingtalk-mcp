export const BlockedReason = {
    NOT_LOGGED_IN: 'not_logged_in',
    TARGET_UNRESOLVED: 'target_unresolved',
    LISTEN_DISCONNECTED: 'listen_disconnected',
    DAEMON_UNAVAILABLE: 'daemon_unavailable',
    SEND_FAILED: 'send_failed',
    DISABLED: 'disabled'
};
export function isBlockedReason(value) {
    return Object.values(BlockedReason).includes(value);
}
//# sourceMappingURL=errors.js.map