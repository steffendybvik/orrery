// `GET /api/releases` → every project with releases of its own, each with the projects they cover and their releases
// without notes, for the Releases page (ORR-671). A release several projects share is one entry, with each one's part.
export default defineEventHandler(async () => await useStore().allReleases())
