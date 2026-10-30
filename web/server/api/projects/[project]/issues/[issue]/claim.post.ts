// `POST /api/projects/:project/issues/:issue/claim` → the issue, taken up by whoever's asking (ORR-657): a person's own, or
// an unassigned one, which it assigns to them; the owner's on anyone's, which takes it over. Shows in the activity. 409
// naming the holder for anyone else, and for an agent on what isn't its person's.
export default defineEventHandler(async event => await useStore().claimIssue(param(event, 'project'), param(event, 'issue'), await actorOf(event)))
