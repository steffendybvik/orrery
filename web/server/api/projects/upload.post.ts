// `POST /api/projects/upload?id=&key=&name=` {a board's file} → the new board, held by whoever uploaded it (ORR-670). It
// never merges into or overwrites a board: an id or key already taken is a 409, and you choose another. A member brings one in
// in person, held to that by `checkBoards`; anyone else goes on to `authorize`, so an agent of theirs is still refused (ORR-725).
export default defineEventHandler(async event => {
    const actor = await memberAsking(event) ?? await authorize(event, 'projects.upload')
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
    // Checked here, without the database; written by the API, which says the board changed (ORR-1142). With no API set
    // up, the store here writes it.
    const checked = checkedBoard(file, {id: text('id'), key: text('key'), name: text('name')})
    const holder = await personOf(event) ?? (await ownerNow()).name
    const sent = await writeToApi('POST', '/api/boards', boardForApi(checked, holder), actor, {always: true})
    if (!sent) {
        await uploadBoard(useDatabase(), file, {id: checked.id, key: checked.key, name: checked.name}, actor, holder)
        useStore().changed(checked.id)
    }
    useEventLog().note({level: 'info', kind: 'board.uploaded', project: checked.id, message: `${actor.name} uploaded a board's file as ${checked.id}`, details: {by: actor.name}})
    return created(event, sent ? sent.reply : await useStore().project(checked.id))
})
