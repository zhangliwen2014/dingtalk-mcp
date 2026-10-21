export declare const BlockedReason: {
    readonly NOT_LOGGED_IN: "not_logged_in";
    readonly TARGET_UNRESOLVED: "target_unresolved";
    readonly LISTEN_DISCONNECTED: "listen_disconnected";
    readonly DAEMON_UNAVAILABLE: "daemon_unavailable";
    readonly SEND_FAILED: "send_failed";
    readonly DISABLED: "disabled";
};
export type BlockedReason = (typeof BlockedReason)[keyof typeof BlockedReason];
export declare function isBlockedReason(value: string): value is BlockedReason;
//# sourceMappingURL=errors.d.ts.map