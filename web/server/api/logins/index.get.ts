// `GET /api/logins` → this person's live logins, or everyone's for the owner (ORR-838): each browser or phone signed in,
// when it was made and last used, with `current` on the one asking. Never what's in a cookie.
import {loginHolderOf} from '../../utils/key-rights'

export default defineEventHandler(async event => {
    const {person, owner} = await loginHolderOf(event, () => authorize(event, 'logins.write'))
    return useStore().logins(owner ? undefined : person, getCookie(event, LOGIN_COOKIE))
})
