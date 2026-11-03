// `GET /api/phone` → {reach, docker, port, addresses}: where a phone can open this orrery, for App settings' link and QR
// code (ORR-833). `reach` is `loopback` while only this machine can, and the addresses are then where it would be.
export default defineEventHandler(event => phoneLinks(event))
