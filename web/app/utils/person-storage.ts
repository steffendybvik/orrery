// What this browser keeps is one person's (ORR-1391): the docs they read (`orrery-read-docs`, their full text), what
// they've seen, their chat's project, the bell's and the event log's marks. It's kept for whoever is signed in, and goes
// when they log out or someone else signs in, so the next person on the browser can't read it in devtools or have
// their dots worked out from it. What's only this device's layout stays.

/** Who this browser's storage belongs to. */
export const STORAGE_PERSON = 'orrery-storage-person'

/** The keys that are the device's, not a person's: how the page is laid out, nothing anyone wrote or saw. */
const DEVICE = new Set([
    'orrery-theme',
    'orrery-doc-size',
    'orrery-chat-large',
    'orrery-chat-float',
    'orrery-sessions-float',
    'orrery-notifications-pane',
    'orrery-sidebar-sessions',
    'orrery-update-hidden',
])

/** Drops every key of orrery's that isn't the device's own. */
export function forgetPerson(storage: Storage = localStorage) {
    const keys = Array.from({length: storage.length}, (_, i) => storage.key(i)).filter((k): k is string => !!k)
    for (const key of keys) if (key.startsWith('orrery-') && !DEVICE.has(key)) storage.removeItem(key)
}

/** Keeps the storage to `person`, who has just been recognised: another person's is dropped first. A browser from
 * before this, with nobody named, keeps what it has, as it was its one person's. */
export function holdStorageTo(person: string, storage: Storage = localStorage) {
    const was = storage.getItem(STORAGE_PERSON)
    if (was !== null && was !== person) forgetPerson(storage)
    storage.setItem(STORAGE_PERSON, person)
}
