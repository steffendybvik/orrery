// Images kept smaller (ORR-446, ORR-1058), as web/server/utils/compress.ts does with sharp: they're most of a database
// (screenshots, mostly PNG), and every backup copies them again. A PNG becomes WebP at quality 90, which looks the same
// for a screenshot at about a third of the size; a JPEG, most often a photo, at 82 (ORR-465). Either is no wider than
// MAX_WIDTH and no taller than WebP can hold, turned as the camera said. A JPEG WebP doesn't make smaller is written
// again as a JPEG at 82 if that is. Whatever's written again loses its metadata (EXIF, a photo's place); one nothing
// makes smaller stays as it was, and so do small ones (an icon: there's little to save), GIFs, WebP and animated PNGs,
// so nothing moving stops. The bytes aren't sharp's, so the parity test compares the type and roughly the size.
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use std::io::Cursor;

const MAX_WIDTH: u32 = 2560;
/// The tallest a WebP can be. A full-page screenshot keeps its width, and so stays readable, rather than being scaled
/// to fit a smaller box; one taller than this is scaled to fit.
pub(crate) const MAX_HEIGHT: u32 = 16383;
/// Smaller than this, an image is kept as it came.
const MIN_SIZE: usize = 16 * 1024;

/// A screenshot's text stays crisp at 90; a photo looks the same at 82, and is much smaller.
fn quality(kind: &str) -> Option<u8> {
    match kind {
        "image/png" => Some(90),
        "image/jpeg" => Some(82),
        _ => None,
    }
}

fn find(data: &[u8], what: &[u8], from: usize) -> Option<usize> {
    data.get(from..)?.windows(what.len()).position(|w| w == what).map(|at| at + from)
}

/// A PNG with frames (APNG) says so in an `acTL` chunk before its first image data.
fn animated(png: &[u8]) -> bool {
    match (find(png, b"acTL", 8), find(png, b"IDAT", 8)) {
        (Some(frames), Some(data)) => frames < data,
        (Some(_), None) => true,
        _ => false,
    }
}

/// The image decoded, turned as its EXIF says (`.rotate()`), and no bigger than MAX_WIDTH by MAX_HEIGHT (`fit:
/// inside`, never enlarged). None when it can't be read, or is too big to hold (the decoder's own limits).
fn sized(data: &[u8], format: ImageFormat) -> Option<DynamicImage> {
    let mut decoder = ImageReader::with_format(Cursor::new(data), format).into_decoder().ok()?;
    let orientation = decoder.orientation().ok()?;
    let mut image = DynamicImage::from_decoder(decoder).ok()?;
    image.apply_orientation(orientation);
    if image.width() > MAX_WIDTH || image.height() > MAX_HEIGHT {
        image = image.resize(MAX_WIDTH, MAX_HEIGHT, FilterType::Lanczos3);
    }
    Some(image)
}

fn webp(image: &DynamicImage, quality: u8) -> Vec<u8> {
    let (width, height) = (image.width(), image.height());
    let encoded = if image.color().has_alpha() {
        let pixels = image.to_rgba8();
        webp::Encoder::from_rgba(&pixels, width, height).encode(f32::from(quality))
    } else {
        let pixels = image.to_rgb8();
        webp::Encoder::from_rgb(&pixels, width, height).encode(f32::from(quality))
    };
    encoded.to_vec()
}

fn jpeg(image: &DynamicImage, quality: u8) -> Option<Vec<u8>> {
    let mut out = vec![];
    JpegEncoder::new_with_quality(&mut out, quality).encode_image(&image.to_rgb8()).ok()?;
    Some(out)
}

/// The image as it's best kept: WebP when that's smaller, else as it came. CPU work, so call it off the async threads.
pub(crate) fn compress_image(data: Vec<u8>, kind: &'static str) -> (&'static str, Vec<u8>) {
    let Some(quality) = quality(kind) else { return (kind, data) };
    if data.len() < MIN_SIZE || (kind == "image/png" && animated(&data)) {
        return (kind, data);
    }
    let format = if kind == "image/png" { ImageFormat::Png } else { ImageFormat::Jpeg };
    // One it can't read is kept as it came: the browser may still show it.
    let Some(image) = sized(&data, format) else { return (kind, data) };
    let as_webp = webp(&image, quality);
    if as_webp.len() < data.len() {
        return ("image/webp", as_webp);
    }
    if kind == "image/jpeg" {
        if let Some(again) = jpeg(&image, quality).filter(|again| again.len() < data.len()) {
            return (kind, again);
        }
    }
    (kind, data)
}

#[cfg(test)]
#[path = "compress_tests.rs"]
mod tests;
