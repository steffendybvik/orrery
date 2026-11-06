// `POST /api/epics/:epic/focus` {note?, session?, start?, status?, instructions?} → {signals, listeners} (ORR-987): asks the
// sessions to work through the epic's open issues, a focus for each project it has open issues in, to one session there
// orrery picks (`session: "*"`: every one listening on it). Each lists only that project's part, as a milestone's focus
// does. `listeners` says how many sessions were listening on each, by project. `start: true`, from the owner, starts a
// session for a project nobody's listening on, even when work alone doesn't start one (`starts.on_signal` off).
export default defineEventHandler(async event => {
    const {start, ...body} = ((await readBody(event).catch(() => null)) ?? {}) as {start?: unknown}
    const actor = await actorOf(event)
    const id = await epicId(event)
    const send = () => useStore().focusEpic(id, body, actor)
    const signals = await (start === true && actor.owner ? startAsked.run(true, send) : send())
    setResponseStatus(event, 201)
    return {signals, listeners: Object.fromEntries(signals.map(s => [s.project, listening(s.project)]))}
})
