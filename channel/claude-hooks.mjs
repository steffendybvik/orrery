// Which of Claude Code's hook events orrery's hook is registered for (ORR-1074), by every setup that writes it: a repo's
// `.claude/settings.json` (repo-setup.mjs, and web/shared/connect.ts for the Connect brief) and the default folder's
// (home-folder.mjs). The Claude adapter's own (claude-agent.mjs `hooks`); kept apart, with no imports, so the web's
// shared code can read it too.

// PreToolUse runs on every tool call, so it runs in the background (`async`): it catches the turns no prompt started (a
// focus signal, a background task finishing). StopFailure runs instead of Stop when a turn ends on an API error, which
// lets go of what the session had in progress.
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Stop', 'StopFailure', 'Notification', 'SessionEnd']
/** The ones that run in the background: Claude Code doesn't wait on them, so they never hold up a tool or answer its prompt. */
export const ASYNC_EVENTS = ['PreToolUse', 'PermissionRequest']
