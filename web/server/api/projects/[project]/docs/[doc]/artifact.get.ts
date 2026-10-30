// `GET /api/projects/:project/docs/:doc/artifact?theme=dark` → an artifact's HTML, locked down however it's opened: in its
// frame on the doc's page, or in a tab of its own (ORR-677). Only an artifact: a Markdown doc's text is never served as a page.
export default defineEventHandler(async event => {
    const doc = await useStore().doc(param(event, 'project'), param(event, 'doc'))
    if (doc.kind !== 'artifact') throw notFound(`Doc "${doc.id}" isn't an artifact`)
    setResponseHeaders(event, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': ARTIFACT_CSP,
    })
    return await artifactPage(doc.body, getQuery(event).theme === 'dark')
})
