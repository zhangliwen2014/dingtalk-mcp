import * as fs from 'node:fs';

export const DTMCP_HOOK_COMMAND = 'dtmcp hook';

type HookEntry = {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
};

type HooksObject = Record<string, unknown>;

function isDtmcpHookCommand(command: string): boolean {
  return (
    command.endsWith('hook') &&
    (command.includes('dtmcp') || command.includes('dingtalk-mcp'))
  );
}

function buildEntries(command: string): Record<string, HookEntry[]> {
  const plain = { hooks: [{ type: 'command', command }] };
  return {
    SessionStart: [plain],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }],
    UserPromptSubmit: [plain],
    Stop: [plain],
    SessionEnd: [plain],
  };
}

export function mergeHooks(
  existing: HooksObject,
  command: string = DTMCP_HOOK_COMMAND
): HooksObject {
  const result: HooksObject = {};

  for (const [event, value] of Object.entries(existing)) {
    if (!Array.isArray(value)) {
      result[event] = value;
      continue;
    }
    const kept: HookEntry[] = [];
    for (const entry of value as HookEntry[]) {
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

export function installHooksFile(
  settingsPath: string,
  command: string = DTMCP_HOOK_COMMAND
): void {
  let settings: HooksObject = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
  }

  settings.hooks = mergeHooks((settings.hooks as HooksObject) ?? {}, command);

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}
