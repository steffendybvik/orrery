import {PERMISSION_LEVELS, PERMISSIONS, SESSION_KINDS} from '#shared/permissions'

// `GET /api/permissions` → {levels, kinds, permissions}: what each kind of session may do (shared/permissions.ts), so a
// session can see it has to ask before it tries and is refused. The Sessions page's Permissions tab shows the same.
export default defineEventHandler(() => ({levels: PERMISSION_LEVELS, kinds: SESSION_KINDS, permissions: PERMISSIONS}))
