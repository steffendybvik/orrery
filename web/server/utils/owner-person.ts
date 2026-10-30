// The owner as the migration moves them from `settings` to `people` (ORR-653), on either database.
import {actorId} from '../store/schema'

/** The owner's row from their `settings` value (their name, as JSON); none for a name with nothing in it to make an id from. */
export function ownerPerson(value: string): {id: string, name: string} | undefined {
    const name = String(JSON.parse(value))
    const id = actorId(name)
    return id ? {id, name} : undefined
}
