// Whether this orrery asks for a login, and who this browser is (ORR-664), read once as the page opens. Off, as on one
// person's own machine, none of it shows.
export interface AuthStatus {
    mode: 'off' | 'on' | 'closed'
    person?: string
    via?: 'browser' | 'agent'
    can_get_in: boolean
    oidc: boolean
    warn_http: boolean
}

export function useAuth() {
    const status = useState<AuthStatus | null>('auth-status', () => null)
    const loggedOut = computed(() => status.value?.mode !== 'off' && !status.value?.person)
    async function logOut() {
        await $fetch('/api/auth/logout', {method: 'POST'})
        location.assign('/login')
    }
    return {status, loggedOut, logOut}
}
