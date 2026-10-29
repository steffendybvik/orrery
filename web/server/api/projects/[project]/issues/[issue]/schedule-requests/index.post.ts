// `POST /api/projects/:project/issues/:issue/schedule-requests` {schedule, id?, why?} → 201 the comment asking: a working
// session asking the owner, on the issue it's working, to make a schedule or change schedule `id` (ORR-458). The comment
// waits on their decision with Allow and Deny; nothing is saved until they allow it. Not the chat (it asks in its chat)
// nor an untrusted session; a session asking on an issue another one is working is refused (409).
export default defineEventHandler(async event => {
    const actor = await authorize(event, 'schedules.ask')
    const [project, issue] = [param(event, 'project'), param(event, 'issue')]
    await claimFor(event, project, issue)
    return created(event, await askScheduleOn(project, issue, await readBody(event).catch(() => null), actor))
})
