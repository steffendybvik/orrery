// `DELETE /api/projects/:project/doc-sections/:section` → 204; its docs are kept, filed under no section.
export default defineEventHandler(async event => {
    await useStore().deleteDocSection(param(event, 'project'), param(event, 'section'))
    return deleted(event)
})
