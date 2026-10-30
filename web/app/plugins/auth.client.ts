// Before anything else asks the API: a browser with no login goes to the login page, and the rest of the page never starts
// (ORR-664). The plugins run in name order, so this one is first. With auth off, it's one quick question and nothing else.
export default defineNuxtPlugin(async () => {
    const {status, loggedOut} = useAuth()
    status.value = await apiFetch<AuthStatus>('/auth/status').catch(() => null)
    const onLogin = location.pathname === '/login'
    if (!status.value || loggedOut.value === onLogin) return
    location.replace(onLogin ? '/' : '/login')
    await new Promise(() => {})
})
