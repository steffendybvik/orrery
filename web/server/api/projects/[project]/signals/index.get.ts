// `GET /api/projects/:project/signals?after=` → the project's signals after that id, oldest first;
// `?issue=` or `?milestone=` gives the latest ones about that issue or milestone instead.
export default defineEventHandler(async event => {
    const query = getQuery(event)
    const text = (key: string) => typeof query[key] === 'string' && query[key] ? String(query[key]) : undefined
    return await useStore().listSignals(param(event, 'project'), Number(query.after ?? 0) || 0, 50, {issue: text('issue'), milestone: text('milestone')})
})
