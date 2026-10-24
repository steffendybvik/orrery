// `GET /api/owner` → {name, display}: the owner's name, which the page sends as `Orrery-Actor`, and the
// name it shows for them.
export default defineEventHandler(() => {
    const {owner, ownerName} = useRuntimeConfig()
    return {name: String(owner), display: String(ownerName || owner)}
})
