// Images kept smaller (ORR-446): they're most of a database (screenshots, mostly PNG), and every backup copies them
// again. A PNG becomes WebP at quality 90, which looks the same for a screenshot at about a third of the size; a
// JPEG, most often a photo, at 82 (ORR-465). Either is no wider than MAX_WIDTH, and no taller than WebP can hold. A
// JPEG WebP doesn't make smaller is written again as a JPEG at 82 if that is. Whatever's written again loses its
// metadata (EXIF, a photo's place); one nothing makes smaller stays as it was, and so do small ones (an icon: there's
// little to save), GIFs, WebP and animated PNGs, so nothing moving stops.
import sharp from 'sharp'

const MAX_WIDTH = 2560
/** The tallest a WebP can be. A full-page screenshot keeps its width, and so stays readable, rather than being
 * scaled to fit a smaller box; one taller than this is scaled to fit. */
export const MAX_HEIGHT = 16383
/** Smaller than this, an image is kept as it came. */
const MIN_SIZE = 16 * 1024
/** A screenshot's text stays crisp at 90; a photo looks the same at 82, and is much smaller. */
const QUALITY = {'image/png': 90, 'image/jpeg': 82} as const

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
        const quality = QUALITY[type]
        const sized = () => sharp(data).rotate().resize({width: MAX_WIDTH, height: MAX_HEIGHT, fit: 'inside', withoutEnlargement: true})
        const webp = await sized().webp({quality}).toBuffer()
        if (webp.length < data.length) return {type: 'image/webp', data: webp}
        if (type === 'image/jpeg') {
            const jpeg = await sized().jpeg({quality, mozjpeg: true}).toBuffer()
            if (jpeg.length < data.length) return {type, data: jpeg}
        }
        return {type, data}
    } catch {
        // One sharp can't read is kept as it came: the browser may still show it.
        return {type, data}
    }
}
