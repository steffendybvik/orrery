// With ORRERY_SEED set (the dev server's .env.dev), fills an empty database with the demo on start.
import {seed} from '../utils/seed'

export default defineNitroPlugin(async () => {
    if (!process.env.ORRERY_SEED) return
    if (await seed(useDatabase())) console.log('[orrery] seeded the demo')
})
