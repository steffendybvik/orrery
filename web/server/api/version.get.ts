// `GET /api/version` → {version, newer}: the version running, and the newest release past it ({version, url}) when the
// last check found one (ORR-608); null when there's none, the check is off or it hasn't run yet.
export default defineEventHandler(() => ({version: String(useRuntimeConfig().public.version), newer: useUpdateCheck().newer}))
