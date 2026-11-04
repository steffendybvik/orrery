import type {Feature} from '#shared/usage'

// Counting feature use (ORR-881): one use of a feature, sent only while the owner has counting on (App settings →
// Advanced), and never waited on. orrery counts only the owner's own.
export function useUsage() {
    const {settings} = useAppSettings()
    const send = (feature: Feature) => apiFetch('/usage', {method: 'POST', body: {feature}}).catch(() => {})
    function count(feature: Feature) {
        // The first page opens before the settings arrive: it waits for them to say whether counting is on.
        if (!settings.value.id) {
            const stop = watch(() => settings.value.id, id => {
                if (!id) return
                stop()
                if (settings.value.count_use) send(feature)
            })
            return
        }
        if (settings.value.count_use) send(feature)
    }
    return {count}
}
