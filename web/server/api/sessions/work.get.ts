// `GET /api/sessions/work?projects=a,b` → {<project>: {<session id>: {issues, signals}}}: what each session is on, for
// every project that has sessions (or those named), in one call for the Sessions page (ORR-442). Each project's as
// `GET /api/projects/:project/sessions/work` has it; one that isn't there is left out.
export default defineEventHandler(async event => {
    const named = String(getQuery(event).projects ?? '').split(',').map(p => p.trim()).filter(Boolean)
    const projects = named.length ? named : [...new Set(listSessions().map(s => s.project))]
    const store = useStore()
    const work = await Promise.all(projects.map(async project => {
        const own = listSessions(project).map(s => ({...s, ids: sessionIds(s.id)}))
        return [project, await store.sessionWork(project, own).catch(() => null)] as const
    }))
    return Object.fromEntries(work.filter(([, found]) => found))
})
