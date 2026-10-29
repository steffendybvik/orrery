// `PUT /api/projects/:project/docs/:doc` {title, body?, position?, section?} → the doc, created (201) or replaced:
// how a Markdown file in the repo is kept in sync.
export default defineEventHandler(async event => {
    const {doc, created: isNew} = await useStore().putDoc(param(event, 'project'), param(event, 'doc'), await readBody(event), await actorOf(event))
    return isNew ? created(event, doc) : doc
})
