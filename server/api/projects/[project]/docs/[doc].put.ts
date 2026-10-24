// `PUT /api/projects/:project/docs/:doc` {title, body?, position?} → the doc, created (201) or replaced:
// how a Markdown file in the repo is kept in sync.
export default defineEventHandler(async event => {
    const {doc, created: isNew} = useStore().putDoc(param(event, 'project'), param(event, 'doc'), await readBody(event), actorOf(event))
    return isNew ? created(event, doc) : doc
})
