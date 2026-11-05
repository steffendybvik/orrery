// `GET /api/epics` → every epic (ORR-895), in the order they're arranged in, a new one on top: `{id, title, notes?,
// issues, kinds, projects: [{project, issues, kinds}]}`, its progress counted across every project it has issues in.
export default defineEventHandler(async () => await useStore().epics())
