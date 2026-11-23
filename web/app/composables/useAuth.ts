// Whether this orrery asks for a login, and who this browser is (ORR-664), read once as the page opens. Off, as on one
// person's own machine, none of it shows.
export interface AuthStatus {
    mode: 'off' | 'on' | 'closed'
    person?: string
    via?: 'browser' | 'agent'
    can_get_in: boolean
    oidc: boolean
    /** A provider's on and lets someone new in (ORRERY_SIGN_UP unset or `open`), so its button signs up too (ORR-1291). */
    sign_up: boolean
    warn_http: boolean
    /** On the phone's own port (ORR-837), where the QR code signs you in. */
    phone?: boolean
}

export function useAuth() {
    const status = useState<AuthStatus | null>('auth-status', () => null)
    const loggedOut = computed(() => status.value?.mode !== 'off' && !status.value?.person)
    // With a login provider, out through its own sign-out too (ORR-1319), so the next sign-in asks who it is rather than
    // landing on the same account; the server sends the browser straight to the login page when the provider has none.
    async function logOut() {
        await apiFetch('/auth/logout', {method: 'POST', headers: {}})
        if (!status.value?.oidc) return location.assign('/login')
        const back = apiCrossOrigin('/auth/oidc/logout') ? `?${new URLSearchParams({back: location.origin})}` : ''
        location.assign(apiUrl(`/auth/oidc/logout${back}`))
    }
    return {status, loggedOut, logOut}
}
