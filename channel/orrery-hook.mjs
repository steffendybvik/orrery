#!/usr/bin/env node
// orrery's Claude Code hook: tells orrery what this session is doing, so the owner can see it and
// point work at an idle one, and which issues it writes to. Registered for SessionStart, UserPromptSubmit,
// PreToolUse, PermissionRequest, Stop, StopFailure, Notification and SessionEnd in the repo's .claude/settings.json, with ORRERY_PROJECT
// (and ORRERY_URL) set, or at user level by the install line (ORRERY_SCOPE=user). It never fails the hook, and prints nothing (a hook's output goes to Claude) but
// after a `/clear`, a compaction or a resume: then orrery's brief of what the session was working on, which
// Claude Code adds to the fresh context so the work carries on. A session orrery started with context gets that
// in the brief too, as it starts and after each of those. Every `SessionStart` also says which repo it's in (ORR-1070),
// but in a session the launcher started, which has that in its system prompt already (ORRERY_REPO_TOLD).
import {basename} from 'node:path'
import {authHeaders} from './credentials.mjs'
import {repoContext} from './repo-context.mjs'
import {claudeWindow} from './session.mjs'
import {claude} from './claude-agent.mjs'
import {standsDown} from './claude-user-setup.mjs'
import {effortOf, modelOf} from './transcript.mjs'

const base = (process.env.ORRERY_URL ?? 'http://localhost:9000').replace(/\/+$/, '')
let input = ''
for await (const chunk of process.stdin) input += chunk
try {
    const hook = JSON.parse(input || '{}')
    // The user-level copy (ORR-1067) leaves a folder with orrery's hook of its own to that one, and a session with no
    // project known says nothing.
    if (standsDown({dir: process.env.CLAUDE_PROJECT_DIR ?? hook.cwd ?? process.cwd()})) process.exit(0)
    const window = claudeWindow()
    const project = process.env.ORRERY_PROJECT ?? basename(hook.cwd ?? process.cwd())
    const context = claude.context(hook)
    const response = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        // Whose this session is, from the user's environment.
        headers: {'Content-Type': 'application/json', ...process.env.ORRERY_PERSON?.trim() ? {'Orrery-Person': process.env.ORRERY_PERSON.trim()} : {}, ...authHeaders(base)},
        signal: AbortSignal.timeout(1500),
        body: JSON.stringify({
            id: hook.session_id ?? window.id,
            pid: window.pid,
            project,
            name: window.name,
            cwd: hook.cwd,
            event: hook.hook_event_name ?? 'idle',
            message: hook.message,
            // `clear` on SessionEnd keeps the window; SessionStart's `source` says if the context was cleared.
            reason: hook.reason,
            source: hook.source,
            // StopFailure's: why the turn was cut off (`rate_limit`, `overloaded`, `server_error`…).
            error: hook.error,
            // And what Claude Code told it, which says when a usage limit resets.
            error_text: hook.hook_event_name === 'StopFailure' && typeof hook.last_assistant_message === 'string' ? hook.last_assistant_message.slice(0, 300) : undefined,
            // The launch orrery started this session for (the launcher hands it down), for the context it was given.
            started: process.env.ORRERY_STARTED,
            // Which issues it's about to write to: an owner's comment on one goes to this session.
            command: hook.hook_event_name === 'PreToolUse' && hook.tool_name === 'Bash' ? String(hook.tool_input?.command ?? '').slice(0, 4000) : undefined,
            // The tool it's about to use, or asks permission for, in a line: what the owner's prompt says it wants.
            tool: hook.tool_name ? {name: String(hook.tool_name).slice(0, 200), detail: toolDetail(hook.tool_name, hook.tool_input)} : undefined,
            // The model it runs on, for the Sessions page (ORR-871).
            model: modelOf(hook),
            // And the effort level it runs at, when its hook says (ORR-894).
            effort: effortOf(hook),
            // And how much context it carries, in tokens, after a turn and on tool events (ORR-968), against its model's
            // window, as the Claude adapter measures them (ORR-1074).
            context: context?.tokens,
            window: context?.window,
        }),
    })
    const {brief, repo} = response.ok ? await response.json() ?? {} : {}
    const where = hook.hook_event_name === 'SessionStart' && !process.env.ORRERY_REPO_TOLD ? repoContext(hook.cwd, {project, repo}) : undefined
    const told = [where, brief].filter(Boolean).join('\n\n')
    // stdout to a pipe can still be writing: exit once the brief is out.
    if (told) await new Promise(resolve => process.stdout.write(`${told}\n`, resolve))
} catch {
    // orrery not running, or slow: the session carries on regardless.
}
process.exit(0)

/** What a tool would do, short: the command, the file, the address or the search. Never a file's contents or
 * anything else from its input: an MCP tool's arguments can hold anything, so it goes by its name alone. */
function toolDetail(name, input) {
    const field = {
        Bash: 'command', Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path', Read: 'file_path',
        NotebookEdit: 'notebook_path', WebFetch: 'url', WebSearch: 'query', Glob: 'pattern', Grep: 'pattern',
    }[name]
    const value = field ? input?.[field] : undefined
    return typeof value === 'string' && value ? value.slice(0, 300) : undefined
}

