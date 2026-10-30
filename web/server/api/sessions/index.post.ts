// `POST /api/sessions` {id?, pid?, project, name?, cwd?, event, message?, command?, tool?, reason?, source?, started?, error?} →
// the session: a Claude session's hook saying who it is and what it's doing (see channel/orrery-hook.mjs). `event` is
// the hook's event name; a `StopFailure` (with its `error`) lets go of the issues the session has in progress. A
// `SessionStart` after a `/clear`, a compaction or a resume (`source`) also brings `brief`: what the session was working
// on, for the hook to hand the fresh context so the work carries on. A session orrery started (`started`, its launch)
// with context gets that in the brief on every `SessionStart`, its first included. `tool` ({name, detail?}, on
// `PreToolUse` and `PermissionRequest`) is what a permission prompt it waits at is for.
import {cutOffLabel} from '#shared/roadmap'
export default defineEventHandler(async event => {
    const body = await readBody(event).catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body.project !== 'string' || typeof body.event !== 'string' || (!body.id && !body.pid)) {
        throw badRequest('Send {project, event} and the session as id or pid')
    }
    const text = (key: string) => typeof body[key] === 'string' && body[key] ? String(body[key]) : undefined
    // An untrusted schedule's session (by its launch, before its channel has said so) works no issue: what it runs is
    // no claim on one, whatever its text names.
    const started = text('started')
    // Read without taking the launch: its channel connecting does that, and gets what it was started as (ORR-468).
    const untrusted = !!(started && launchUntrusted(body.project, started))
    const tool = body.tool && typeof body.tool === 'object' ? body.tool as Record<string, unknown> : undefined
    const session = report({
        id: text('id'), pid: Number(body.pid) || undefined, project: body.project, name: text('name'),
        cwd: text('cwd'), event: body.event, message: text('message'), command: untrusted ? undefined : text('command')?.slice(0, 4000), reason: text('reason'), source: text('source'),
        error: text('error'), errorText: text('error_text')?.slice(0, 300),
        tool: tool && typeof tool.name === 'string' && tool.name ? {
            name: tool.name.slice(0, 200), ...typeof tool.detail === 'string' && tool.detail ? {detail: tool.detail.slice(0, 300)} : {},
        } : undefined,
    })
    if (session && body.event === 'Stop') {
        considerClear(session.project, session.id)
        carryOn(session.project, session.id)
        pickWhenIdle(session.project, session.id)
    }
    // Cut off by an API error: what it had in progress isn't being worked any more.
    if (session && body.event === 'StopFailure') {
        useEventLog().note({level: 'warn', kind: 'session.cut_off', project: session.project, message: `${session.name}: ${cutOffLabel(session.cut_off ?? {})}`, details: {session: session.id, error: session.cut_off?.error ?? null}})
        await letGo(session.project, session.id, text('error')).catch(error => console.error(`[orrery] letting go of ${session.id}'s work:`, error))
        considerClear(session.project, session.id)
    }
    const source = text('source')
    if (!session || body.event !== 'SessionStart') return session
    // What it was given before is out of its context now, so the Context page counts it no more (ORR-575).
    if (source === 'clear' || source === 'compact') noteContextCut(session.id)
    // Back from orrery's clear with part of its run left: a focus on the rest starts its next turn.
    // With none, it picks its next issue, when the owner lets sessions (ORR-452).
    if (source === 'clear' && session.started) {
        const project = body.project
        clearDone(session.id)
        resumeRun(project, session.id)
            .then(resumed => resumed || pickNext(project, session.id))
            .catch(error => console.error(`[orrery] resuming ${session.id}'s run:`, error))
    }
    const api = `${getRequestURL(event).origin}/api/projects/${encodeURIComponent(body.project)}`
    // Its launch as its hook says (before its channel has connected) or as orrery knows it.
    const brief = await sessionBrief(useStore(), {project: body.project, session: session.id, source, launch: text('started') ?? session.started?.launch, api})
    return brief ? {...session, brief} : session
})
