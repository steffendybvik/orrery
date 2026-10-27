import {SESSION_STATES, type SessionState} from '#shared/roadmap'

// `POST /api/sessions/message` {text, projects?, states?} → 201 `{sent: [{project, session, name, signal}]}`: the owner's
// own words to every listening session at once, each its own message as if sent to it alone. Idle ones only unless
// `states` says otherwise, so a nudge doesn't interrupt work; `projects` narrows it to sessions on (or hearing) any of
// them. A session hearing several projects gets it once. Nobody listening is an empty `sent`, not a launch.
export default defineEventHandler(async event => {
    const actor = await actorOf(event)
    if (!actor.owner) throw forbidden('Only the owner messages sessions; send Orrery-Actor: <owner>')
    const body = await readBody(event).catch(() => null) as {text?: unknown, projects?: unknown, states?: unknown} | null
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text) throw badRequest('Send the message as {"text": "…"}')
    const list = (value: unknown, name: string) => {
        if (value === undefined || value === null) return undefined
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw badRequest(`Send ${name} as a list of strings`)
        return value as string[]
    }
    const projects = list(body?.projects, 'projects')
    const states = list(body?.states, 'states')
    const unknown = states?.find(s => !(SESSION_STATES as readonly string[]).includes(s))
    if (unknown) throw badRequest(`No session state ${unknown}: use ${SESSION_STATES.join(', ')}`)
    const store = useStore()
    const sent = []
    for (const session of recipients(projects, states as SessionState[] | undefined)) {
        sent.push({project: session.project, session: session.id, name: session.name, signal: await store.messageSession(session.project, session.id, text, actor)})
    }
    return created(event, {sent})
})
