// `POST /api/projects/:project/issues/:issue/schedule-requests/:comment` {allow} → the comment asking, answered: the owner
// allowing (the schedule is made or changed as theirs) or denying a session's request, from the issue's page (ORR-458).
// Their answer is a comment of theirs too. The owner's alone, so a session can't allow its own; 409 once answered or
// expired.
export default defineEventHandler(async event => {
    const actor = await authorize(event, 'schedules.answer')
    const body = await readBody(event).catch(() => null) as {allow?: unknown} | null
    if (typeof body?.allow !== 'boolean') throw badRequest('Send {"allow": true} or {"allow": false}')
    const comment = Number(param(event, 'comment'))
    if (!Number.isInteger(comment)) throw badRequest("Send the asking comment's id")
    return await answerScheduleRequest(param(event, 'project'), param(event, 'issue'), comment, body.allow, actor)
})
