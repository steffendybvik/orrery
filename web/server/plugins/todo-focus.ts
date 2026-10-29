// Hands an issue the owner moves into Todo (or makes there) to an idle session (ORR-515, see utils/todo-focus.ts).
export default defineNitroPlugin(() => {
    projectEvents.on('happened', heardTodo)
})
