// `POST /api/auth/claim` {name?} → 201 {person, person_key, agent_key}: claims this orrery from its page on this machine
// (ORR-832), as `orrery:claim` does from a shell, and signs this browser in. Each key's secret is in it this once. `name`
// names the owner when nobody has yet. Off this machine, or once claimed, it's refused (`claimRefusal`).
export default defineEventHandler(async event => {
    const refusal = await claimRefusal(event)
    if (refusal) throw refusal
    const {name} = (await readBody<{name?: unknown}>(event)) ?? {}
    const store = useStore()
    if (!(await store.ownerOf()).named) {
        if (typeof name !== 'string' || !name.trim()) throw badRequest('This orrery has no owner yet: give your name as "name"')
        await store.nameOwner({name})
    }
    const claimed = await store.claimOrrery()
    await logIn(event, claimed.person, claimed.person_key.id)
    setResponseStatus(event, 201)
    return claimed
})
