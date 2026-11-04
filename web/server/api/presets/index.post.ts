// `POST /api/presets` {name, text} → 201 the new preset, the orrery's: the owner's only.
import {countOwnUse} from '../../utils/usage'

export default defineEventHandler(async event => {
    countOwnUse(event, 'presets')
    const preset = await useStore().createPreset(null, await readBody(event), await actorOf(event))
    setResponseStatus(event, 201)
    return preset
})
