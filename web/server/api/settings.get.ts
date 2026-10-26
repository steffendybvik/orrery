// `GET /api/settings` → this Orrery's own settings, e.g. `{id, environment, tint}`.
export default defineEventHandler(async () => ({...await useStore().settings(), environment: String(useRuntimeConfig().public.environment || 'personal')}))
