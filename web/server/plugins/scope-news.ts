// Tells the session on an issue when the epic or milestone it sits under changes, or it moves out of one (ORR-984, see
// utils/scope-news.ts).
export default defineNitroPlugin(() => {
    projectEvents.on('happened', heardScope)
})
