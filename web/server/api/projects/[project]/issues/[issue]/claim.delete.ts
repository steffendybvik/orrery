// `DELETE /api/projects/:project/issues/:issue/claim` → the issue, let go (ORR-657): the holder's, or the owner's on anyone's.
// It stays assigned. Shows in the activity. 409 for anyone else.
export default defineEventHandler(async event => await useStore().releaseIssue(param(event, 'project'), param(event, 'issue'), await actorOf(event)))
