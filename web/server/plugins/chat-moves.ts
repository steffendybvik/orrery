// Shows on a chat's move request what has changed on its issues while it waits (ORR-644, see utils/chats.ts).
export default defineNitroPlugin(() => {
    projectEvents.on('happened', heardForMoves)
})
