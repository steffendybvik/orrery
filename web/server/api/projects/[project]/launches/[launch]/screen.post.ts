// `POST /api/projects/:project/launches/:launch/screen` {screen} → {watching}: the launcher sending the screen of a
// session it started, as the owner views it; it stops once `watching` is false. It sends the key its stream's `ready`
// gave it as `Orrery-Launcher`; without it, 403, so nothing else can show the owner a screen that isn't the session's.
export default defineEventHandler(async event => {
    const {screen} = checkInput(await readBody(event).catch(() => ({})) ?? {}, {screen: {type: 'string', required: true}})
    return keepScreen(param(event, 'project'), param(event, 'launch'), String(screen), getHeader(event, 'orrery-launcher')?.trim())
})
