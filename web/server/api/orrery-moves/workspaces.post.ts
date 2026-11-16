// `POST /api/orrery-moves/workspaces` {url, key}: the other orrery's workspaces, as its owner sees them, for App settings to
// choose which to bring in or add to (ORR-1249). The owner's alone, from their page; the key goes no further.
export default defineEventHandler(async event => {
    await authorize(event, 'orrery.move')
    await moveByOwnersPage(event)
    const body = await readBody(event)
    const ask = moveAskOf({...body, direction: 'bring', name: 'workspaces'})
    const {workspaces} = await moveSides(event, ask)
    return workspaces.map((w: {id: string, name: string, color?: string, role?: string}) => ({id: w.id, name: w.name, color: w.color, role: w.role}))
})
