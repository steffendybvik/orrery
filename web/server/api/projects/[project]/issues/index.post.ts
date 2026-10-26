// `POST /api/projects/:project/issues` {title, status?, priority?, assignee?, labels?, external?, notes?,
// proposal?, choices?, parent?, chunk?, release?, position?} → the new issue, with the project's next id (`KEY-n`).
export default defineEventHandler(async event => created(event, await useStore().createIssue(param(event, 'project'), await readBody(event), await actorOf(event))))
