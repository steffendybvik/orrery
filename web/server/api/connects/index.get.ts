// `GET /api/connects` → {pickers, current?}: how many connected launchers can open a folder picker, and the request under
// way, if there is one (ORR-708). The owner's, so a member gets a 403 (ORR-1195).
export default defineEventHandler(event => {
    ownersOwn(event.context.who as Who | undefined, 'Connecting a folder')
    return {pickers: pickersConnected(), current: currentConnect()}
})
