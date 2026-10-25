// `POST /api/sessions` {id?, pid?, project, name?, cwd?, event, message?, command?} → the session: a Claude session's hook
// saying who it is and what it's doing (see channel/orrery-hook.mjs). `event` is the hook's event name.
export default defineEventHandler(async event => {
    const body = await readBody(event).catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body.project !== 'string' || typeof body.event !== 'string' || (!body.id && !body.pid)) {
        throw badRequest('Send {project, event} and the session as id or pid')
    }
    const text = (key: string) => typeof body[key] === 'string' && body[key] ? String(body[key]) : undefined
    return report({
        id: text('id'), pid: Number(body.pid) || undefined, project: body.project, name: text('name'),
        cwd: text('cwd'), event: body.event, message: text('message'), command: text('command')?.slice(0, 4000),
    })
})
