// `POST /api/schedules` {projects: '*' | [ids], skip?, …a schedule's fields} → the schedule across projects, made on each.
import {countOwnUse} from '../utils/usage'

export default defineEventHandler(async event => {
    countOwnUse(event, 'schedules')
    return created(event, await useScheduler().createAcross(await readBody(event), await actorOf(event)))
})
