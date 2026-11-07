#!/usr/bin/env node
// orrery's Claude Code hook: tells orrery what this session is doing, so the owner can see it and
// point work at an idle one, and which issues it writes to. Registered for SessionStart, UserPromptSubmit,
// PreToolUse, PermissionRequest, Stop, StopFailure, Notification and SessionEnd in the repo's .claude/settings.json, with ORRERY_PROJECT
// (and ORRERY_URL) set. It never fails the hook, and prints nothing (a hook's output goes to Claude) but
// after a `/clear`, a compaction or a resume: then orrery's brief of what the session was working on, which
// Claude Code adds to the fresh context so the work carries on. A session orrery started with context gets that
// in the brief too, as it starts and after each of those. Every `SessionStart` also says which repo it's in (ORR-1070),
// but in a session the launcher started, which has that in its system prompt already (ORRERY_REPO_TOLD).
// What the hook's input means is the agent adapter's to read (`report`, agents.mjs): this file knows only the report.
import {basename} from 'node:path'
import {authHeaders} from './credentials.mjs'
import {repoContext} from './repo-context.mjs'
import {claudeWindow} from './session.mjs'
import {agentFor} from './agents.mjs'

// The agent this hook is registered for: Claude Code, the only adapter so far.
const agent = agentFor()
const base = (process.env.ORRERY_URL ?? 'http://localhost:9000').replace(/\/+$/, '')
let input = ''
for await (const chunk of process.stdin) input += chunk
try {
    const hook = JSON.parse(input || '{}')
    const window = claudeWindow()
    // What the session is doing, as its agent's adapter reads its hook's input (ORR-1074).
    const {id, cwd, ...report} = agent.report(hook)
    const project = process.env.ORRERY_PROJECT ?? basename(cwd ?? process.cwd())
    const response = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        // Whose this session is, from the user's environment.
        headers: {'Content-Type': 'application/json', ...process.env.ORRERY_PERSON?.trim() ? {'Orrery-Person': process.env.ORRERY_PERSON.trim()} : {}, ...authHeaders(base)},
        signal: AbortSignal.timeout(1500),
        body: JSON.stringify({
            id: id ?? window.id,
            pid: window.pid,
            project,
            name: window.name,
            cwd,
            ...report,
            // The launch orrery started this session for (the launcher hands it down), for the context it was given.
            started: process.env.ORRERY_STARTED,
        }),
    })
    const {brief, repo} = response.ok ? await response.json() ?? {} : {}
    const where = report.event === 'SessionStart' && !process.env.ORRERY_REPO_TOLD ? repoContext(cwd, {project, repo}) : undefined
    const told = [where, brief].filter(Boolean).join('\n\n')
    // stdout to a pipe can still be writing: exit once the brief is out.
    if (told) await new Promise(resolve => process.stdout.write(`${told}\n`, resolve))
} catch {
    // orrery not running, or slow: the session carries on regardless.
}
process.exit(0)
