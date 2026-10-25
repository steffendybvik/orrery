// `GET /api/notices` → agents' latest comments across projects, newest first (the page's bell). With
// `?all=true` every one, the cleared ones too (`cleared: true`): the notifications page.
export default defineEventHandler(event => getQuery(event).all === 'true' ? useStore().notices(null, true) : useStore().notices())
