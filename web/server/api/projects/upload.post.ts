// `POST /api/projects/upload?id=&key=&name=` {a board's file} → the new board, held by whoever uploaded it (ORR-670). It
// never merges into or overwrites a board: an id or key already taken is a 409, and you choose another.
export default defineEventHandler(async event => {
    const actor = await authorize(event, 'projects.upload')
    const tooBig = () => createError({statusCode: 413, statusMessage: `A board's file is ${BOARD_LIMIT / 1024 / 1024} MB at most`})
    if (Number(getHeader(event, 'content-length')) > BOARD_LIMIT) throw tooBig()
    const raw = await readRawBody(event)
    if (raw && raw.length > BOARD_LIMIT) throw tooBig()
    let file: unknown
    try {
        file = JSON.parse(raw ?? '')
    } catch {
        throw badRequest('That isn\'t a board\'s file: it isn\'t JSON')
    }
    const query = getQuery(event)
    const text = (name: string) => typeof query[name] === 'string' && query[name] ? query[name] as string : undefined
    const store = useStore()
    const id = await uploadBoard(useDatabase(), file, {id: text('id'), key: text('key'), name: text('name')}, actor, await personOf(event) ?? (await store.ownerOf()).name)
    store.changed(id)
    useEventLog().note({level: 'info', kind: 'board.uploaded', project: id, message: `${actor.name} uploaded a board's file as ${id}`, details: {by: actor.name}})
    return created(event, await store.project(id))
})
