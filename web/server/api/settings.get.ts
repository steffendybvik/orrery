// `GET /api/settings` → this orrery's own settings, e.g. `{id, tint, statuses, …}`: every one that's stored, which the
// Rust API serves once the router sends it there (ORR-954). What only this server knows, which orrery it's run as and
// where its data is, is `GET /api/machine`.
export default defineEventHandler(async () => await useStore().settings())
