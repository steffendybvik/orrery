// Adds the presets orrery ships that this orrery hasn't had yet (shared/presets.ts), as it starts.
export default defineNitroPlugin(() => {
    useStore().seedPresets().catch(error => console.error('[orrery] adding the presets orrery ships:', error))
})
