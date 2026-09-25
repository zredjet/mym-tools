//! Colour management: the input's colour tag decides how the output is tagged and whether the palette is
//! converted to sRGB.
//!
//! The pixels of a screenshot are in the colour space of the display it was taken on. macOS embeds that display's
//! ICC profile in the PNG (`iCCP`: Display P3, or a measured profile of a built-in panel whose curves differ from
//! sRGB's), and its BMP writer converts the pixels to sRGB and says so in the V5 header. A viewer honours the tag.
//! Up to 0.7.0 shotq dropped it, so its output was shown as if it were sRGB: darker or duller than the original on
//! any display whose profile is not sRGB. Since 0.8.0 the output is tagged sRGB and the palette is converted to it.
//! A colour transform is a function of the colour alone, so converting the palette entries after the remap gives
//! the same image as converting every pixel first (up to near ties in the nearest-colour search), at no per-pixel
//! cost: the whole step takes well under a millisecond.
//!
//! Rules, applied identically to what either PNG reader found, so the output never depends on the thread count:
//! - untagged input -> untagged output, bytes unchanged from 0.7.0
//! - `sRGB` chunk; `gAMA` within 5% of 1/2.2 with no `cHRM` or an sRGB one (libpng's threshold); a BMP whose V5
//!   header says LCS_sRGB or LCS_WINDOWS_COLOR_SPACE -> tag only: `sRGB` + `gAMA` chunks (29 bytes), as pngquant writes
//! - `iCCP`, or a profile embedded in a V5 BMP -> qcms (Firefox's colour management library, pure Rust, MIT)
//!   transforms the palette to sRGB. A profile that moves no probe colour by more than one level is treated as
//!   sRGB and the palette is left alone: qcms and littlecms both jitter ±1 on the embedded sRGB profiles of GIMP
//!   and macOS, and a flat colour must not move for nothing. A profile qcms cannot read is written to the output as
//!   its own `iCCP`, so the image still looks like the original.
//! - any other `gAMA` (+ `cHRM`) -> a matrix/gamma profile built from the values, then as for `iCCP`
//! - a GRAY profile (`iCCP` on a greyscale PNG, colour type 0 or 4) -> qcms Gray8 -> RGB8 on the grey palette; on
//!   colour data such a profile is invalid and ignored, as ColorSync does. One qcms cannot read is dropped: a GRAY
//!   profile must not be written to a palette image.
//!
//! `iCCP` wins over `sRGB`, which wins over `gAMA`/`cHRM` (the PNG specification's order). `cICP` is ignored;
//! macOS writes it next to an `iCCP` that says the same thing.

use crate::color::Rgba;

#[derive(Clone, Debug, PartialEq)]
pub enum Colour {
    None,
    Srgb,
    /// An RGB ICC profile, decompressed.
    Profile(Vec<u8>),
    /// A GRAY ICC profile on a greyscale image, decompressed.
    GrayProfile(Vec<u8>),
    /// `gAMA` as stored (1/gamma, e.g. 0.45455) and, if present, `cHRM` as white, red, green, blue x/y pairs.
    Gamma { gamma: f32, chrm: Option<[f32; 8]> },
}

/// The sRGB primaries and D65 white as `cHRM` stores them (x, y of white, red, green, blue).
pub const SRGB_CHRM: [f32; 8] = [0.3127, 0.3290, 0.64, 0.33, 0.30, 0.60, 0.15, 0.06];

impl Colour {
    /// `gAMA` (+ `cHRM`) as read from a PNG: sRGB within tolerance, else a gamma space to convert from.
    pub fn from_gamma(gamma: f32, chrm: Option<[f32; 8]>) -> Colour {
        let srgb_gamma = (gamma - 0.45455).abs() <= 0.05 * 0.45455;
        let srgb_chrm = chrm.map_or(true, |c| c.iter().zip(&SRGB_CHRM).all(|(a, b)| (a - b).abs() <= 0.001));
        if srgb_gamma && srgb_chrm { Colour::Srgb } else { Colour::Gamma { gamma, chrm } }
    }

    /// The body of a PNG `iCCP` chunk: keyword, NUL, method 0, zlib stream. `None` for anything the png crate
    /// ignores (bad keyword or method, a stream that does not inflate), so that both readers agree.
    pub fn from_iccp(body: &[u8]) -> Option<Vec<u8>> {
        let k = body.iter().position(|&b| b == 0).filter(|&k| (1..=80).contains(&k))?;
        if body.get(k + 1) != Some(&0) { return None; }
        fdeflate::decompress_to_vec_bounded(&body[k + 2..], 64 << 20).ok()
    }
}

/// What to write: the palette (converted if needed) and the colour chunks that go between IHDR and PLTE.
pub struct Tagged { pub pal: Vec<Rgba>, pub chunks: Vec<u8>, pub note: &'static str }

pub fn to_srgb(colour: &Colour, pal: &[Rgba]) -> Tagged {
    let keep = |chunks: Vec<u8>, note| Tagged { pal: pal.to_vec(), chunks, note };
    match colour {
        Colour::None => keep(Vec::new(), ""),
        Colour::Srgb => keep(srgb_chunks(), "sRGB"),
        Colour::Profile(icc) => match qcms::Profile::new_from_slice(icc, false).and_then(|p| convert(&p, pal)) {
            Some((pal, true)) => Tagged { pal, chunks: srgb_chunks(), note: "ICC profile converted to sRGB" },
            Some((_, false)) => keep(srgb_chunks(), "sRGB (ICC profile)"),
            None => keep(iccp_chunk(icc), "ICC profile kept, not converted"),
        },
        Colour::Gamma { gamma, chrm } => match gamma_profile(*gamma, *chrm).and_then(|p| convert(&p, pal)) {
            Some((pal, true)) => Tagged { pal, chunks: srgb_chunks(), note: "gAMA/cHRM converted to sRGB" },
            Some((_, false)) => keep(srgb_chunks(), "sRGB (gAMA/cHRM)"),
            None => keep(gamma_chunks(*gamma, *chrm), "gAMA/cHRM kept, not converted"),
        },
        Colour::GrayProfile(icc) => match qcms::Profile::new_from_slice(icc, false).and_then(|p| convert_gray(&p, pal)) {
            Some((pal, true)) => Tagged { pal, chunks: srgb_chunks(), note: "grey ICC profile converted to sRGB" },
            Some((_, false)) => keep(srgb_chunks(), "sRGB (grey ICC profile)"),
            None => keep(Vec::new(), "grey ICC profile not readable, dropped"),
        },
    }
}

/// Is this decompressed ICC profile for GRAY data (header bytes 16..20)?
pub fn is_gray_profile(icc: &[u8]) -> bool { icc.get(16..20) == Some(b"GRAY") }

/// Chunks that restate the input's colour space: for a truecolor output whose pixels were not converted.
pub fn passthrough_chunks(colour: &Colour) -> Vec<u8> {
    match colour {
        Colour::None => Vec::new(),
        Colour::Srgb => srgb_chunks(),
        Colour::Profile(icc) | Colour::GrayProfile(icc) => iccp_chunk(icc),
        Colour::Gamma { gamma, chrm } => gamma_chunks(*gamma, *chrm),
    }
}

/// Transforms the palette to sRGB with qcms; `false` if the profile is sRGB as far as 8-bit values can tell.
fn convert(input: &qcms::Profile, pal: &[Rgba]) -> Option<(Vec<Rgba>, bool)> {
    let mut srgb = qcms::Profile::new_sRGB();
    srgb.precache_output_transform();
    let xfm = qcms::Transform::new(input, &srgb, qcms::DataType::RGB8, qcms::Intent::Perceptual)?;
    // The probe: the grey ramp and a 6x6x6 grid. Measured on the sRGB profiles of GIMP and macOS: 1-2% of the
    // values move by 1, none by 2. Display P3 moves saturated colours by up to 56 levels, a gamma 1.8 curve moves
    // mid greys by ~19: neither can pass.
    let mut probe: Vec<u8> = (0..=255u8).flat_map(|g| [g, g, g]).collect();
    for r in (0..=255u16).step_by(51) { for g in (0..=255u16).step_by(51) { for b in (0..=255u16).step_by(51) { probe.extend([r as u8, g as u8, b as u8]); } } }
    let before = probe.clone();
    xfm.apply(&mut probe);
    if probe.iter().zip(&before).all(|(a, b)| a.abs_diff(*b) <= 1) { return Some((pal.to_vec(), false)); }
    let mut rgb: Vec<u8> = pal.iter().flat_map(|c| [c.r, c.g, c.b]).collect();
    xfm.apply(&mut rgb);
    Some((pal.iter().zip(rgb.chunks_exact(3)).map(|(c, x)| Rgba { r: x[0], g: x[1], b: x[2], a: c.a }).collect(), true))
}

/// The grey palette of a greyscale image through a GRAY profile: qcms maps Gray8 to sRGB RGB8, so one 256-entry
/// table covers every value. `false` if the profile is sRGB's curve as far as 8-bit values can tell.
fn convert_gray(input: &qcms::Profile, pal: &[Rgba]) -> Option<(Vec<Rgba>, bool)> {
    let mut srgb = qcms::Profile::new_sRGB();
    srgb.precache_output_transform();
    let xfm = qcms::Transform::new_to(input, &srgb, qcms::DataType::Gray8, qcms::DataType::RGB8, qcms::Intent::Perceptual)?;
    let greys: Vec<u8> = (0..=255u8).collect();
    let mut table = vec![0u8; 768];
    xfm.convert(&greys, &mut table);
    if table.chunks_exact(3).zip(&greys).all(|(o, &g)| o.iter().all(|&v| v.abs_diff(g) <= 1)) { return Some((pal.to_vec(), false)); }
    Some((pal.iter().map(|c| { let o = &table[c.r as usize * 3..][..3]; Rgba { r: o[0], g: o[1], b: o[2], a: c.a } }).collect(), true))
}

/// A display profile with the `cHRM` primaries (sRGB's if absent) and a pure power curve of exponent 1/`gAMA`.
fn gamma_profile(gamma: f32, chrm: Option<[f32; 8]>) -> Option<Box<qcms::Profile>> {
    if !(gamma > 0.0) || !gamma.is_finite() { return None; }
    let c = chrm.unwrap_or(SRGB_CHRM);
    let xy = |x: f32, y: f32| qcms::CIE_xyY { x: x as f64, y: y as f64, Y: 1.0 };
    let g = 1.0 / gamma;
    qcms::Profile::new_rgb_with_gamma_set(xy(c[0], c[1]), qcms::CIE_xyYTRIPLE { red: xy(c[2], c[3]), green: xy(c[4], c[5]), blue: xy(c[6], c[7]) }, g, g, g)
}

/// `sRGB` (perceptual) + `gAMA` 1/2.2: what pngquant writes for a converted image.
fn srgb_chunks() -> Vec<u8> {
    let mut out = Vec::with_capacity(29);
    crate::chunk(&mut out, b"sRGB", &[0]);
    crate::chunk(&mut out, b"gAMA", &45455u32.to_be_bytes());
    out
}

fn gamma_chunks(gamma: f32, chrm: Option<[f32; 8]>) -> Vec<u8> {
    let mut out = Vec::new();
    crate::chunk(&mut out, b"gAMA", &((gamma * 1e5).round() as u32).to_be_bytes());
    if let Some(c) = chrm {
        let body: Vec<u8> = c.iter().flat_map(|v| ((v * 1e5).round() as u32).to_be_bytes()).collect();
        crate::chunk(&mut out, b"cHRM", &body);
    }
    out
}

/// The profile as an `iCCP` chunk, recompressed (the same bytes whichever reader found it).
fn iccp_chunk(icc: &[u8]) -> Vec<u8> {
    let mut body = b"ICC profile\0\0".to_vec();
    body.extend_from_slice(&crate::zlib_parallel(icc, 9));
    let mut out = Vec::with_capacity(body.len() + 12);
    crate::chunk(&mut out, b"iCCP", &body);
    out
}
