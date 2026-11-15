// Keeps the images uploaded before they were compressed (ORR-446) as WebP too, once, as orrery starts, in the
// background. On SQLite the Rust API then compacts the file (ORR-1134), as the space they gave back would otherwise stay
// in it, and writes through and cuts back the `-wal` the compacting filled. This server never touches the file (ORR-1135).
import {ORRERY} from '../store/schema'

export default defineNitroPlugin(() => {
    const store = useStore()
    store.compressUploads().then(async done => {
        if (!done?.images) return
        await writeToApi('POST', '/api/database/compact', {always: true}, ORRERY, {always: true})
        useEventLog().note({level: 'info', kind: 'uploads.compressed', message: `Compressed ${done.images} images, ${(done.saved / 1024 / 1024).toFixed(1)} MB smaller`})
    }).catch(error => console.error('[orrery] compressing the images:', error))
})
