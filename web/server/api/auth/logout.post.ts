// `POST /api/auth/logout` → 204: ends this browser's login, on the server as well as its cookie.
export default defineEventHandler(async event => {
    const login = getCookie(event, loginCookie(event))
    if (login) await useStore().endLogin(login)
    deleteCookie(event, loginCookie(event), {path: '/'})
    setResponseStatus(event, 204)
    return null
})
