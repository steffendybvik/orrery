// `GET /api/projects/:project/docs` → its docs, without their text but with a summary; `?q=` only those with it in them.
export default defineEventHandler(async event => {
    const {q} = getQuery(event)
    return useStore().listDocs(param(event, 'project'), {q: q === undefined ? undefined : String(q)})
})
