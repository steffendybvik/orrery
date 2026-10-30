import {randomBytes} from 'node:crypto'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** A board's or a server's random id (ORR-674): 8 characters of base32, 40 bits. */
export function randomUid(): string {
    let bits = 0n
    for (const byte of randomBytes(5)) bits = bits << 8n | BigInt(byte)
    return Array.from({length: 8}, (_, i) => ALPHABET[Number(bits >> BigInt(5 * i) & 31n)]).join('')
}
