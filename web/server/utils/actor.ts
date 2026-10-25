import type {H3Event} from 'h3'
import type {Actor} from './store'

// Who's asking, by the `Orrery-Actor` header (`agent` without one). There's no auth: it's what
// keeps an agent from deleting what the owner (their id, from the name they gave) made, as long as
// agents name themselves.
export async function actorOf(event: H3Event): Promise<Actor> {
    const name = getHeader(event, 'orrery-actor')?.trim().slice(0, 60) || 'agent'
    return {name, owner: name.toLowerCase() === (await useStore().ownerOf()).name}
}
