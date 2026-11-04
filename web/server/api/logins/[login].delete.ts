// `DELETE /api/logins/:login` → 204: ends that login at once (ORR-838), so a lost phone is signed out. A person's own, or
// anyone's for the owner.
import {loginHolderOf} from '../../utils/key-rights'

export default defineEventHandler(async event => {
    const {person, owner} = await loginHolderOf(event, () => authorize(event, 'logins.write'))
    await useStore().endLoginById(param(event, 'login'), owner ? undefined : person)
    setResponseStatus(event, 204)
    return null
})
