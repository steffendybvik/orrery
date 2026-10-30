// `GET /api/people` → everyone on this orrery, the owner first: `{id, name, role, created_at, removed_at?}`, those
// removed with when. An id is what a session sets as `ORRERY_PERSON`.
export default defineEventHandler(async () => useStore().people())
