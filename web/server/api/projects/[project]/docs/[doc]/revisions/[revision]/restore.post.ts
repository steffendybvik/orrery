// `POST /api/projects/:project/docs/:doc/revisions/:revision/restore` → the doc with that revision's title and text, as a
// new revision: 200, or 201 when it brings a deleted doc back.
export default defineEventHandler(async event => {
    const {doc, created: isNew} = await useStore().restoreDoc(param(event, 'project'), param(event, 'doc'), Number(param(event, 'revision')), await actorOf(event))
    return isNew ? created(event, doc) : doc
})
