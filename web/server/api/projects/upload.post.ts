// `POST /api/projects/upload?id=&key=&name=&own=` {a board's file} → the new board, held by whoever uploaded it (ORR-670). It
// never merges into or overwrites a board: an id or key already taken is a 409, and you choose another. A member brings one in
// in person, held to that by `checkBoards`; anyone else goes on to `authorize`, so an agent of theirs is still refused (ORR-725).
// The file is checked here (`checkedBoard`), and the Rust API makes the board from its rows (`POST /api/boards`, ORR-1142).
// `&into=1`: the rest of a board too big for one request, sent after it in parts (ORR-1257), a file of the board's project
// row and its comments, events or doc revisions, added to the board `id` that whoever uploads it holds.
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
    // up, the upload fails as one that isn't running does (ORR-1135).
    const into = query.into === '1' || query.into === 'true'
    if (into && !(text('id') && text('key'))) throw badRequest('Name the board the rest of its file goes into: "id" and "key"')
    const checked = checkedBoard(file, {id: text('id'), key: text('key'), name: text('name'), into})
    const holder = await personOf(event) ?? (await ownerNow()).name
    // Into the workspace the page is in (ORR-1195).
    // `?own=1`: the owner's own board from another orrery of theirs, keeping who said what (ORR-1110); the API holds it to them.
    const own = query.own === '1' || query.own === 'true'
    const sent = await writeToApi('POST', '/api/boards', {...boardForApi(checked, holder), ...own ? {own: true} : {}, ...into ? {into: true} : {}}, actor, {always: true, workspace: getHeader(event, 'orrery-workspace')})
    if (!sent) throw createError({statusCode: 503, statusMessage: 'Uploading a board needs the Rust API, which isn\'t running'})
    if (into) return sent.reply
    // The board the API made: an id only another workspace has comes back as `<id>-2` (ORR-1350), and the line goes in the
    // workspace it was made in, never the one that has the id asked for (ORR-1409).
    const made = sent.reply as {id?: string, workspace?: string} | undefined
    const id = made?.id ?? checked.id
    const workspace = made?.workspace ?? getHeader(event, 'orrery-workspace')
    useEventLog().note({level: 'info', kind: 'board.uploaded', project: id, ...workspace ? {workspace} : {}, message: `${actor.name} uploaded a board's file as ${id}`, details: {by: actor.name}})
    return created(event, sent.reply)
})
