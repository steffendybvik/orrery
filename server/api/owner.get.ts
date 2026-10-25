// `GET /api/owner` → {name, display, named}: the owner's id, which the page sends as `Orrery-Actor`, the
// name it shows for them, and whether they've given it yet (the page asks on first open).
export default defineEventHandler(() => useStore().ownerOf())
