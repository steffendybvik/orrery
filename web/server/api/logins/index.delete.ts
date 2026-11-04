// `DELETE /api/logins` → {ended}: ends every login but the asking browser's (ORR-838), a person's own or, for the owner,
// everyone's. On this machine's page with login off there's no login to keep, so every one ends.
import {loginHolderOf} from '../../utils/key-rights'

export default defineEventHandler(async event => {
    const {person, owner} = await loginHolderOf(event, () => authorize(event, 'logins.write'))
    return {ended: await useStore().endOtherLogins(owner ? undefined : person, getCookie(event, LOGIN_COOKIE))}
})
