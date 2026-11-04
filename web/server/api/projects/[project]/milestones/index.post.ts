// `POST /api/projects/:project/milestones` {title, summary?, priority?, position?} → the new milestone, with the project's next number.
import {countOwnUse} from '../../../../utils/usage'

export default defineEventHandler(async event => {
    countOwnUse(event, 'milestones')
    return created(event, await useStore().createMilestone(param(event, 'project'), await readBody(event), await actorOf(event)))
})
