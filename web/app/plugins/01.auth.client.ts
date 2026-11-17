// Before anything else asks the API: a browser with no login goes to the login page, and the rest of the page never starts
// (ORR-664). The plugins run in name order, so this one is first. With auth off, it's one quick question and nothing else.
const AFTER_LOGIN = 'orrery-after-login'

export default defineNuxtPlugin(async () => {
    const {status, loggedOut} = useAuth()
    status.value = await apiFetch<AuthStatus>('/auth/status').catch(() => null)
    const onLogin = location.pathname === '/login'
    if (status.value && !loggedOut.value) await usePeople().load()
    // Where a browser sent to log in was going, such as a machine's Connect page (ORR-1192): back there once it's in.
    if (status.value && !loggedOut.value && !onLogin) {
        const {clear, go} = afterLogin(sessionStorage.getItem(AFTER_LOGIN), location.pathname + location.search)
        if (clear) sessionStorage.removeItem(AFTER_LOGIN)
        if (go) {
            location.replace(go)
            await new Promise(() => {})
        }
    }
    if (!status.value || loggedOut.value === onLogin) return
    if (!onLogin && location.pathname !== '/') sessionStorage.setItem(AFTER_LOGIN, location.pathname + location.search)
    location.replace(onLogin ? sessionStorage.getItem(AFTER_LOGIN) ?? '/' : '/login')
    if (onLogin) sessionStorage.removeItem(AFTER_LOGIN)
    await new Promise(() => {})
})
