// Tells the Rust API again, every half minute, which sessions are there to hear (ORR-1172, utils/presence.ts): it
// takes one it hasn't heard of for 90 seconds as gone, so the beat keeps the ones still here from lapsing.
const BEAT = 30_000

export default defineNitroPlugin(nitro => {
    const timer = setInterval(() => void sayPresence({all: true}), BEAT)
    timer.unref()
    nitro.hooks.hook('close', () => clearInterval(timer))
})
