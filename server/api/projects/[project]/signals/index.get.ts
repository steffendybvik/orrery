// `GET /api/projects/:project/signals?after=` → the project's signals after that id, oldest first;
// `?issue=` or `?chunk=` gives the latest ones about that issue or chunk instead.
export default defineEventHandler(event => {
    const query = getQuery(event)
    const text = (key: string) => typeof query[key] === 'string' && query[key] ? String(query[key]) : undefined
    return useStore().listSignals(param(event, 'project'), Number(query.after ?? 0) || 0, 50, {issue: text('issue'), chunk: text('chunk')})
})
