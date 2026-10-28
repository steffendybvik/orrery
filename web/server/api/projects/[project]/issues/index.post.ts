// `POST /api/projects/:project/issues` {title, status?, priority?, assignee?, labels?, external?, notes?,
// proposal?, choices?, parent?, chunk?, release?, position?} → the new issue, with the project's next id (`KEY-n`).
// From an untrusted schedule's session (`Orrery-Untrusted`, or its `Orrery-Session`), it's made a proposal labelled
// `external`, whatever it asks.
export default defineEventHandler(async event => {
    const body = await readBody(event)
    const issue = await useStore().createIssue(param(event, 'project'), untrustedWrite(event) ? asProposal(body) : body, await actorOf(event))
    workedOn(event, issue)
    return created(event, issue)
})
