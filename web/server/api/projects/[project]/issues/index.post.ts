// `POST /api/projects/:project/issues` {title, status?, priority?, assignee?, labels?, external?, github_issues?, notes?,
// proposal?, choices?, parent?, chunk?, release?, position?} → the new issue, with the project's next id (`KEY-n`).
// From an untrusted schedule's session (`Orrery-Untrusted`, or its `Orrery-Session`), it's made a proposal labelled
// `external`, whatever it asks; from the owner's chat (`Orrery-Chat`), it's made with nobody on it, in Todo or Backlog as
// the owner picked for the chat (`Orrery-Launch`), whatever status it asks for (a proposal stays one).
export default defineEventHandler(async event => {
    const body = await readBody(event)
    const asked = untrustedWrite(event) ? asProposal(body) : chatWrite(event) ? asChatIssue(body, getHeader(event, 'orrery-launch')?.trim()) : body
    const issue = await useStore().createIssue(param(event, 'project'), asked, await actorOf(event))
    workedOn(event, issue)
    return created(event, issue)
})
