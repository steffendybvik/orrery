import {connectPieces, idsFor, lockedBrief} from '#shared/connect'

// `GET /connect/<project>.md?session=` → the brief for a Claude session in that project's repo: how to
// keep its roadmap here, and how to set the repo up (CLAUDE.md, the orrery channel, the hooks). For a
// project that doesn't exist yet, `?name=` names it, and the brief has the agent create it. With a login on and no
// credential, it's the same few lines for every project, there or not, saying to ask again with a key (ORR-689).
export default defineEventHandler(async event => {
    const file = param(event, 'file')
    if (!file.endsWith('.md')) throw notFound(`No ${file}: ask for /connect/<project>.md`)
    const query = getQuery(event)
    const id = file.slice(0, -3)
    const named = typeof query.name === 'string' && query.name.trim() ? query.name.slice(0, 100) : undefined
    const session = typeof query.session === 'string' ? query.session : undefined
    setResponseHeader(event, 'Content-Type', 'text/markdown; charset=utf-8')
    if (!await mayRead(event)) {
        const asked = named ?? id
        return lockedBrief(connectPieces({origin: originOf(event), id: idsFor(asked).id, name: asked, key: '', isNew: !!named, session}).url)
    }
    const project = (await useStore().listProjects()).find(p => p.id === id)
    const name = project?.name ?? named ?? id
    const {brief} = connectPieces({
        origin: originOf(event),
        id: project?.id ?? idsFor(name).id,
        name,
        key: project?.key ?? idsFor(name).key,
        isNew: !project,
        session,
        login: await authMode(event) !== 'off',
        orrery: {id: (await useStore().settings()).id, environment: String(useRuntimeConfig().public.environment || 'personal')},
    })
    return brief
})
