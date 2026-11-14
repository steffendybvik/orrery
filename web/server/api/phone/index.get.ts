// `GET /api/phone` → {reach, docker, port, addresses}: where a phone can open this orrery, for App settings' link and QR
// code (ORR-833). `reach` is `loopback` while only this machine can, and the addresses are then where it would be. The
// machine's own addresses are the installation's: a signed-in member who isn't the owner gets none (ORR-1195).
export default defineEventHandler(event => {
    const links = phoneLinks(event)
    const who = event.context?.who as Who | undefined
    return who && !who.owner ? {...links, addresses: []} : links
})
