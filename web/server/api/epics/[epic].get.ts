// `GET /api/epics/:epic` → the epic with its issues in `parts`, a section per project: `{project, name, issues, kinds,
// tasks}`, the issues set for it there (a sub-issue's when its parent isn't), each with its sub-issues.
export default defineEventHandler(async event => await useStore().epic(epicId(event)))
