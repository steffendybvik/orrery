// `GET /api/projects/:project/signals?after=` → the project's signals after that id, oldest first;
// `?issue=` gives the latest ones about that issue instead.
export default defineEventHandler(event => {
    const query = getQuery(event)
    return useStore().listSignals(param(event, 'project'), Number(query.after ?? 0) || 0, 50, typeof query.issue === 'string' ? query.issue : undefined)
})
