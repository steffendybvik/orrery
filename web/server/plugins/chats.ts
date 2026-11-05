// Reads the owner's chats kept in the database as orrery starts (ORR-877, see utils/chats.ts), and lets the last of
// their writes land as it stops, before the database plugin closes it (plugins run in name order).
export default defineNitroPlugin(nitro => {
    void chatsLoaded()
    nitro.hooks.hook('close', () => chatsSaved())
})
