// `POST /api/projects/:project/issues` {title, id?, status?, plan?, priority?, assignee?, labels?, notes?,
// parent?, chunk?, position?} → the new issue. Without an id it gets the project's next one (`KEY-n`).
export default defineEventHandler(async event => {
    const issue = await useStore().createIssue(param(event, 'project'), await readBody(event), await actorOf(event))
    workedOn(event, issue)
    return created(event, issue)
})
