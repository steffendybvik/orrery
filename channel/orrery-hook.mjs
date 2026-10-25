#!/usr/bin/env node
// Orrery's Claude Code hook: tells Orrery what this session is doing, so the owner can see it and
// point work at an idle one, and which issues it writes to. Registered for SessionStart, UserPromptSubmit,
// PreToolUse, Stop, Notification and SessionEnd in the repo's .claude/settings.json, with ORRERY_PROJECT
// (and ORRERY_URL) set. It prints nothing (a hook's output would go to Claude) and never fails the hook.
import {basename} from 'node:path'
import {claudeWindow} from './session.mjs'

const base = (process.env.ORRERY_URL ?? 'http://localhost:9000').replace(/\/+$/, '')
let input = ''
for await (const chunk of process.stdin) input += chunk
try {
    const hook = JSON.parse(input || '{}')
    const window = claudeWindow()
    await fetch(`${base}/api/sessions`, {
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
            // Which issues it's about to write to: an owner's comment on one goes to this session.
            command: hook.hook_event_name === 'PreToolUse' && hook.tool_name === 'Bash' ? String(hook.tool_input?.command ?? '').slice(0, 4000) : undefined,
        }),
    })
} catch {
    // Orrery not running, or slow: the session carries on regardless.
}
process.exit(0)
