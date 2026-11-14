// Makes up for the hand-back waits a restart dropped (ORR-1184, see `handBackUnseen` in utils/clearing.ts): once live
// sessions have had as long to reconnect as an ended one has to come back, what the ones still gone had in progress goes back.
export default defineNitroPlugin(nitro => {
    const started = new Date().toISOString()
    const timer = setTimeout(() => {
        handBackUnseen(started).then(handed => {
            if (handed.length) console.log(`[orrery] handed back ${handed.join(', ')}: their sessions were gone after the restart`)
        }, error => console.error('[orrery] handing back what sessions gone over a restart had:', error))
    }, HAND_BACK_AFTER)
    timer.unref()
    nitro.hooks.hook('close', () => clearTimeout(timer))
})
