// The tests of board/compress.rs (ORR-1058): images made here, so what comes out can be decoded and measured.
use super::*;
use image::codecs::png::PngEncoder;
use image::{ImageEncoder, RgbImage, RgbaImage};

/// Noise, which compresses badly as PNG, so it's well over MIN_SIZE and WebP makes it smaller.
fn noise(width: u32, height: u32) -> RgbImage {
    let mut seed = 0x2545_f491_u32;
    RgbImage::from_fn(width, height, |_, _| {
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (seed & 0xff) as u8
        };
        image::Rgb([next(), next(), next()])
    })
}

fn png(image: &RgbImage) -> Vec<u8> {
    let mut out = vec![];
    PngEncoder::new(&mut out).write_image(image, image.width(), image.height(), image::ExtendedColorType::Rgb8).unwrap();
    out
}

fn jpeg_of(image: &RgbImage, quality: u8) -> Vec<u8> {
    let mut out = vec![];
    JpegEncoder::new_with_quality(&mut out, quality).encode_image(image).unwrap();
    out
}

/// A JPEG whose EXIF says to turn it a quarter clockwise (orientation 6) and where it was taken, as a phone writes it.
fn turned_jpeg(image: &RgbImage) -> Vec<u8> {
    let plain = jpeg_of(image, 95);
    let mut tiff = b"II*\0\x08\0\0\0".to_vec();
    tiff.extend_from_slice(&[1, 0]); // one entry
    tiff.extend_from_slice(&[0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0]); // Orientation: 6
    tiff.extend_from_slice(&[0, 0, 0, 0]); // no next IFD
    tiff.extend_from_slice(b"GPS 59.9139 10.7522");
    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend_from_slice(&tiff);
    let mut out = vec![0xff, 0xd8, 0xff, 0xe1];
    out.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&app1);
    out.extend_from_slice(&plain[2..]);
    out
}

fn size_of_webp(data: &[u8]) -> (u32, u32) {
    let decoded = webp::Decoder::new(data).decode().expect("a WebP");
    (decoded.width(), decoded.height())
}

fn has(data: &[u8], what: &[u8]) -> bool {
    data.windows(what.len()).any(|w| w == what)
}

#[test]
fn a_big_png_is_kept_as_a_smaller_webp() {
    let data = png(&noise(400, 300));
    let before = data.len();
    let (kind, after) = compress_image(data, "image/png");
    assert_eq!(kind, "image/webp");
    assert!(after.len() < before, "{} isn't under {before}", after.len());
    assert_eq!(size_of_webp(&after), (400, 300), "a small enough one keeps its size");
}

#[test]
fn a_png_with_alpha_stays_see_through() {
    let image = RgbaImage::from_fn(300, 300, |x, y| image::Rgba([(x * 7) as u8, (y * 13) as u8, ((x ^ y) * 31) as u8, (x % 256) as u8]));
    let mut data = vec![];
    PngEncoder::new(&mut data).write_image(&image, 300, 300, image::ExtendedColorType::Rgba8).unwrap();
    assert!(data.len() >= MIN_SIZE);
    let (kind, after) = compress_image(data, "image/png");
    assert_eq!(kind, "image/webp");
    let decoded = webp::Decoder::new(&after).decode().unwrap();
    assert!(decoded.is_alpha(), "the alpha is kept");
}

#[test]
fn a_wide_one_is_made_no_wider_than_the_most() {
    let (kind, after) = compress_image(png(&noise(3000, 120)), "image/png");
    assert_eq!(kind, "image/webp");
    assert_eq!(size_of_webp(&after), (2560, 102), "scaled to fit, keeping its shape");
}

#[test]
fn a_tall_screenshot_keeps_its_width() {
    let (_, after) = compress_image(png(&noise(200, 5000)), "image/png");
    assert_eq!(size_of_webp(&after), (200, 5000), "taller than the width cap, but under WebP's own");
}

#[test]
fn a_photo_is_turned_as_the_camera_said_and_loses_its_metadata() {
    let data = turned_jpeg(&noise(300, 200));
    assert!(has(&data, b"Exif") && has(&data, b"GPS"));
    let (kind, after) = compress_image(data, "image/jpeg");
    assert_eq!(kind, "image/webp");
    assert_eq!(size_of_webp(&after), (200, 300), "turned a quarter, as orientation 6 says");
    assert!(!has(&after, b"Exif") && !has(&after, b"GPS"), "no EXIF, so no place");
}

#[test]
fn small_ones_are_kept_as_they_came() {
    let data = png(&noise(20, 20));
    assert!(data.len() < MIN_SIZE);
    assert_eq!(compress_image(data.clone(), "image/png"), ("image/png", data));
}

#[test]
fn gifs_and_webps_are_kept_as_they_came() {
    let data = vec![7u8; MIN_SIZE * 2];
    assert_eq!(compress_image(data.clone(), "image/gif"), ("image/gif", data.clone()));
    assert_eq!(compress_image(data.clone(), "image/webp"), ("image/webp", data));
}

#[test]
fn an_animated_png_is_kept_so_it_still_moves() {
    let mut data = png(&noise(200, 200));
    // Its acTL goes before the first IDAT, as an APNG has it.
    let at = find(&data, b"IDAT", 8).unwrap() - 4;
    let mut actl = vec![0, 0, 0, 8];
    actl.extend_from_slice(b"acTL");
    actl.extend_from_slice(&[0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
    data.splice(at..at, actl);
    assert!(animated(&data));
    assert_eq!(compress_image(data.clone(), "image/png"), ("image/png", data));
}

#[test]
fn an_actl_after_the_image_data_is_not_an_animation() {
    let mut data = png(&noise(10, 10));
    data.extend_from_slice(b"acTL");
    assert!(!animated(&data));
}

#[test]
fn one_it_cant_read_is_kept_as_it_came() {
    let mut data = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    data.resize(MIN_SIZE * 2, 0xab);
    assert_eq!(compress_image(data.clone(), "image/png"), ("image/png", data));
}

#[test]
fn what_comes_back_is_never_bigger_than_what_came() {
    for data in [png(&noise(400, 300)), jpeg_of(&noise(400, 300), 30), jpeg_of(&noise(400, 300), 100)] {
        let before = data.len();
        let (_, after) = compress_image(data, "image/jpeg");
        assert!(after.len() <= before);
    }
}
