// `GET /api/notices` → agents' latest comments across projects, newest first (the page's bell).
export default defineEventHandler(() => useStore().notices())
