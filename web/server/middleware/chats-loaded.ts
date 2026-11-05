// Holds a request to the API until the chats kept in the database are read back as orrery starts (ORR-877), so a
// chat's page, its messages and its session's replies find it. Read once; after that this waits on nothing.
export default defineEventHandler(async event => {
    if (event.path.startsWith('/api/')) await chatsLoaded()
})
