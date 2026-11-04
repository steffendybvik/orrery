// `POST /api/projects/:project/chunks` {title, summary?, priority?, position?} → the new chunk, with the project's next number.
import {countOwnUse} from '../../../../utils/usage'

export default defineEventHandler(async event => {
    countOwnUse(event, 'chunks')
    return created(event, await useStore().createChunk(param(event, 'project'), await readBody(event), await actorOf(event)))
})
