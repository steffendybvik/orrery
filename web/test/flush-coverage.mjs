// Loaded into a spawned process while coverage is collected (spawn-coverage.ts). V8 only writes it on a clean exit, which the
// default end to SIGTERM isn't. A process with its own handler stays in charge of how it stops.
process.on('SIGTERM', () => {
    if (process.listenerCount('SIGTERM') === 1) process.exit(143)
})
