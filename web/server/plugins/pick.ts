// Hands idle sessions out of work the issues they may start again when the board changes, or the owner turns
// `pick_next` on (see utils/pick.ts). A burst of writes is one check, a few seconds after it.
export default defineNitroPlugin(() => {
    projectEvents.on('project', () => recheckIdle())
    projectEvents.on('settings', () => recheckIdle())
})
