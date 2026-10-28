// Adds the presets Orrery ships that this Orrery hasn't had yet (shared/presets.ts), as it starts.
export default defineNitroPlugin(() => {
    useStore().seedPresets().catch(error => console.error('[orrery] adding the presets Orrery ships:', error))
})
