// A session works in one workspace, the one its calls name (`Orrery-Workspace`, ORR-1109). One that reaches a project in
// another is refused (ORR-1309, `heldToWorkspace`), reads and writes alike, on the routes this server answers itself
// (launches, sessions, context, pulls…), as the Rust API's rails refuse it on its own. Before `zz-api`, so it holds
// those too when no Rust API is set up.
export default defineEventHandler(async event => {
    if (event.method === 'OPTIONS') return
    await heldToWorkspace(event)
})
