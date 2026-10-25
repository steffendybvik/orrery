// `POST /api/projects/:project/import` {chunks: […]} in `docs/roadmap.json`'s format → the project.
// Refused when the project already has chunks or issues, unless `?replace=true`.
export default defineEventHandler(async event => {
    let roadmap
    try {
        roadmap = checkRoadmap(await readBody(event))
    } catch (error) {
        if (error instanceof RoadmapError) throw badRequest(error.message, error.details)
        throw error
    }
    return await useStore().importRoadmap(param(event, 'project'), roadmap, getQuery(event).replace === 'true', await actorOf(event))
})
