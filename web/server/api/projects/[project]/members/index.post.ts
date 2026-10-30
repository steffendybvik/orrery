// `POST /api/projects/:project/members` {person} → 201 them on the board: its holder's to do, or the owner's, and never an agent's.
export default defineEventHandler(async event => created(event, await useStore().addMember(param(event, 'project'), await readBody(event), await actorOf(event))))
