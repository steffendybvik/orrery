import type {Feature} from '#shared/usage'

// Counting feature use (ORR-881): one use of a feature, sent only while the owner has counting on (App settings →
// Advanced), and never waited on. orrery counts only the owner's own.
export function useUsage() {
    const {settings} = useAppSettings()
    function count(feature: Feature) {
        if (!settings.value.count_use) return
        apiFetch('/usage', {method: 'POST', body: {feature}}).catch(() => {})
    }
    return {count}
}
