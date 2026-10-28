// Keeps the images uploaded before they were compressed (ORR-446) as WebP too, once, as orrery starts, in the
// background. On SQLite the file is then compacted, as the space they gave back would otherwise stay in it, and the
// `-wal` the compacting filled is written through and cut back.
export default defineNitroPlugin(() => {
    const store = useStore()
    store.compressUploads().then(async done => {
        if (!done?.images) return
        const db = useDatabase()
        if (db instanceof SqliteDb) await db.alone(raw => raw.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)'))
        useEventLog().note({level: 'info', kind: 'uploads.compressed', message: `Compressed ${done.images} images, ${(done.saved / 1024 / 1024).toFixed(1)} MB smaller`})
    }).catch(error => console.error('[orrery] compressing the images:', error))
})
