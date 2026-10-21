import * as fs from 'node:fs';
export const DTMCP_HOOK_COMMAND = 'dtmcp hook';
function isDtmcpHookCommand(command) {
    return (command.endsWith('hook') &&
        (command.includes('dtmcp') || command.includes('dingtalk-mcp')));
}
function buildEntries(command) {
    const plain = { hooks: [{ type: 'command', command }] };
    return {
        SessionStart: [plain],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }],
        UserPromptSubmit: [plain],
        Stop: [plain],
        SessionEnd: [plain],
    };
}
export function mergeHooks(existing, command = DTMCP_HOOK_COMMAND) {
    const result = {};
    for (const [event, value] of Object.entries(existing)) {
        if (!Array.isArray(value)) {
            result[event] = value;
            continue;
        }
        const kept = [];
        for (const entry of value) {
            if (!entry || !Array.isArray(entry.hooks)) {
                kept.push(entry);
                continue;
            }
            const hooks = entry.hooks.filter((h) => !isDtmcpHookCommand(h.command ?? ''));
            if (hooks.length > 0) {
                kept.push({ ...entry, hooks });
            }
        }
        result[event] = kept;
    }
    const additions = buildEntries(command);
    for (const [event, entries] of Object.entries(additions)) {
        const current = result[event];
        result[event] = Array.isArray(current) ? [...current, ...entries] : entries;
    }
    return result;
}
export function installHooksFile(settingsPath, command = DTMCP_HOOK_COMMAND) {
    let settings = {};
    if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
    }
    settings.hooks = mergeHooks(settings.hooks ?? {}, command);
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}
//# sourceMappingURL=install-hooks.js.map