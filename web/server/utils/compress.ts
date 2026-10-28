// Images kept smaller (ORR-446): they're most of a database (screenshots, mostly PNG), and every backup copies them
// again. A PNG or JPEG becomes WebP at quality 90, which looks the same for a screenshot at about a third of the
// size, and no wider than MAX_WIDTH. One that WebP doesn't make smaller stays as it was, and so do small ones (an
// icon: there's little to save), GIFs, WebP and animated PNGs, so nothing moving stops.
import sharp from 'sharp'

export const MAX_WIDTH = 2560
/** Smaller than this, an image is kept as it came. */
export const MIN_SIZE = 16 * 1024
const QUALITY = 90

/** A PNG with frames (APNG) says so in an `acTL` chunk before its first image data. */
function animated(png: Buffer): boolean {
    const data = png.indexOf('IDAT', 8, 'latin1')
    const frames = png.indexOf('acTL', 8, 'latin1')
    return frames >= 0 && (data < 0 || frames < data)
}

/** The image as it's best kept: WebP when that's smaller, else as it came. */
export async function compressImage(data: Buffer, type: string): Promise<{type: string, data: Buffer}> {
    if ((type !== 'image/png' && type !== 'image/jpeg') || data.length < MIN_SIZE) return {type, data}
    if (type === 'image/png' && animated(data)) return {type, data}
    try {
        const webp = await sharp(data).rotate().resize({width: MAX_WIDTH, withoutEnlargement: true}).webp({quality: QUALITY}).toBuffer()
        return webp.length < data.length ? {type: 'image/webp', data: webp} : {type, data}
    } catch {
        // One sharp can't read is kept as it came: the browser may still show it.
        return {type, data}
    }
}
