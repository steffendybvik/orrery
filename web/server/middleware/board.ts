// Every write is checked against the board it's on, by the permissions table's `member` column (ORR-654, `checkBoards`).
export default defineEventHandler(async event => {
    await checkBoards(event)
})
