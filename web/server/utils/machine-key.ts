import {ORRERY} from '../store/schema'

// The agent key a machine gets once it's connected (ORR-1192): made by the API, as only it writes keys, for `person`,
// reaching every workspace they're in, named after the machine. Asked as the owner, who may make anyone's.
export async function machineKey(person: string, name: string): Promise<string> {
    const owner = await useStore().ownerOf()
    const sent = await writeToApi('POST', '/api/keys', {kind: 'agent', name, person, all_workspaces: true}, {...ORRERY, name: owner.name, owner: true}, {always: true, noteKeys: false})
    const key = (sent?.reply as {key?: unknown} | undefined)?.key
    if (typeof key !== 'string') throw createError({statusCode: 503, statusMessage: 'Service Unavailable', message: "This orrery couldn't make the machine's key just now: run the line again"})
    return key
}
