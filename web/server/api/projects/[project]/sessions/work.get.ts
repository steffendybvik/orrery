// `GET /api/projects/:project/sessions/work` → {<session id>: {issues, signals}}: what each of the project's
// sessions is on, for its Sessions page. `issues` are the open ones it worked last, newest first; `signals`
// the last five that went to it.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    return await useStore().sessionWork(project, listSessions(project))
})
