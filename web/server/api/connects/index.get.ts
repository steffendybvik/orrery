// `GET /api/connects` → {pickers, current?}: how many connected launchers can open a folder picker, and the request under
// way, if there is one (ORR-708).
export default defineEventHandler(() => ({pickers: pickersConnected(), current: currentConnect()}))
