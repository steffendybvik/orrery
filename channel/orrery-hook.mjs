#!/usr/bin/env node
// Orrery's Claude Code hook: tells Orrery what this session is doing, so the owner can see it and
// point work at an idle one, and which issues it writes to. Registered for SessionStart, UserPromptSubmit,
// PreToolUse, Stop, StopFailure, Notification and SessionEnd in the repo's .claude/settings.json, with ORRERY_PROJECT
// (and ORRERY_URL) set. It never fails the hook, and prints nothing (a hook's output goes to Claude) but
// after a `/clear`, a compaction or a resume: then Orrery's brief of what the session was working on, which
// Claude Code adds to the fresh context so the work carries on. A session Orrery started with context gets that
// in the brief too, as it starts and after each of those.
import {basename} from 'node:path'
import {claudeWindow} from './session.mjs'

const base = (process.env.ORRERY_URL ?? 'http://localhost:9000').replace(/\/+$/, '')
let input = ''
for await (const chunk of process.stdin) input += chunk
try {
    const hook = JSON.parse(input || '{}')
    const window = claudeWindow()
    const response = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        signal: AbortSignal.timeout(1500),
        body: JSON.stringify({
            id: hook.session_id ?? window.id,
            pid: window.pid,
            project: process.env.ORRERY_PROJECT ?? basename(hook.cwd ?? process.cwd()),
            name: window.name,
            cwd: hook.cwd,
            event: hook.hook_event_name ?? 'idle',
            message: hook.message,
            // `clear` on SessionEnd keeps the window; SessionStart's `source` says if the context was cleared.
            reason: hook.reason,
            source: hook.source,
            // StopFailure's: why the turn was cut off (`rate_limit`, `overloaded`, `server_error`…).
            error: hook.error,
            // The launch Orrery started this session for (the launcher hands it down), for the context it was given.
            started: process.env.ORRERY_STARTED,
            // Which issues it's about to write to: an owner's comment on one goes to this session.
            command: hook.hook_event_name === 'PreToolUse' && hook.tool_name === 'Bash' ? String(hook.tool_input?.command ?? '').slice(0, 4000) : undefined,
        }),
    })
    const {brief} = response.ok ? await response.json() ?? {} : {}
    // stdout to a pipe can still be writing: exit once the brief is out.
    if (brief) await new Promise(resolve => process.stdout.write(`${brief}\n`, resolve))
} catch {
    // Orrery not running, or slow: the session carries on regardless.
}
process.exit(0)
