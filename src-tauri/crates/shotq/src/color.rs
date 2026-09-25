//! Colour space and colour difference used for clustering and remapping.
//!
//! A colour is the 4-vector `[alpha, wr*R*alpha, wg*G*alpha, wb*B*alpha]`: each sRGB channel as its linear light
//! to the power 0.59 (the 8-bit code value, 0..1, raised to GAMMA = 1.3), weighted per channel and premultiplied
//! by alpha. The weights are the square roots of 2:4:3, the widely used low-cost approximation of perceived colour
//! difference in sRGB (a weighted Euclidean distance with weights 2, 4, 3 on the red, green and blue differences).
//! The channel curve was chosen by measurement on the bench set (docs/HANDOFF.md P10 and P12), each candidate with
//! the quality scale recalibrated to 0.3.0's colour counts: Oklab and the plain code values resolve dark shades so
//! finely that dark-themed screenshots grew 36% and 31%, the square root of light (1.1) still 16%; 1.3 keeps every
//! real screenshot within -3.5..+0.6% of 0.3.0's size while every image still beats libimagequant's PSNR (by
//! 0.3 dB on the dark theme); linear light or its 2/3 power (1.47) fall below libimagequant on dark themes.
//! `SHOTQ_GAMMA` overrides the exponent for experiments (tools/calibrate.py recalibrates the quality scale for it).
//! For translucent colours `diff` takes the worse of what is seen over black (the
//! premultiplied values) and over white (each channel gains the transparency 1 - alpha, weighted). The 0..100
//! quality scale built on this metric is shotq's own (quant.rs).
//!
//! `diff` adds a luminance term on top of the three channel differences (0.9.0, HANDOFF P16): the Rec. 709
//! luminance of the difference, in the same curve units, squared and scaled by LUMA_K. Luminance is what the eye
//! resolves most finely, and the three channel weights alone let the quantizer merge grey shades that pngquant
//! keeps: at the same flags a grey ramp came out with 26 levels against 34, and the neutral pixels of real
//! screenshots 0.2-4.7 dB below pngquant while the chromatic pixels were above. The term costs a grey step
//! (2.25 + LUMA_K) times its square instead of 2.25, a pure red step only 1.10 times as much, so colour content is
//! nearly untouched. It is a quadratic form, so the k-means mean stays the optimal centre and Wu's split uses
//! the same form (quant.rs `q2`). `SHOTQ_LUMA` overrides LUMA_K for experiments. The quality scale was left at
//! its 0.8.0 value on purpose: the owner chose fidelity over size, so the same `--quality` now asks for more of
//! the palette. The *reported* quality and the `--quality` floor use `diff_report`, the 0.8.0 metric without the
//! luminance term, so that the number keeps its meaning (a 256-colour screenshot that scored 77 still scores 77;
//! with the stricter metric it would have fallen below the floor of 70 and been kept lossless).

pub type Rgba = rgb::RGBA8;

/// Per-channel weights: sqrt(2), sqrt(4), sqrt(3), normalised to green = 1.
pub const W: [f32; 3] = [0.707_106_77, 1.0, 0.866_025_4];
/// Exponent on the code value (0..1): 2.2 would be linear light, 1.1 its square root, 1.3 light to the power 0.59.
const GAMMA: f32 = 1.3;
/// Weight of the squared luminance difference in `diff` (0 = the 0.8.0 metric). Chosen by measurement, HANDOFF P16.
const LUMA_K: f32 = 4.0;
/// Rec. 709 luminance coefficients over the *weighted* channel values (the stored vector), scaled by sqrt(LUMA_K):
/// the luminance term of `diff` is (LUMA . d)^2.
pub fn luma() -> [f32; 3] {
    static L: std::sync::OnceLock<[f32; 3]> = std::sync::OnceLock::new();
    *L.get_or_init(|| luma_coeffs(luma_k()))
}
/// The luminance weight in force (LUMA_K or `SHOTQ_LUMA`).
pub fn luma_k() -> f32 {
    static K: std::sync::OnceLock<f32> = std::sync::OnceLock::new();
    *K.get_or_init(|| std::env::var("SHOTQ_LUMA").ok().and_then(|s| s.parse().ok()).unwrap_or(LUMA_K).max(0.0))
}
/// Luminance of a difference of stored (weighted) vectors, unscaled: `luma_unit() . d` is the Rec. 709 luminance
/// of the difference in curve units.
#[inline(always)]
pub fn luma_unit() -> [f32; 3] { [0.2126 / W[0], 0.7152 / W[1], 0.0722 / W[2]] }
/// Tightening of the grey shades in the divisive step (P21): with RHO > 0 the splitting stops only when the
/// reference error (no luminance term) meets the `--quality` target *and* the luminance error of the neutral
/// boxes meets target / RHO. A pure grey ramp has a reference error of 2.25 d^2 and a luminance error of d^2 per
/// step d, so RHO = 2.25 changes nothing and RHO = 6.25 asks the same of greys as the design metric with LUMA_K = 4.
/// 0 keeps the 0.9.0 rule (stop on the design error). `SHOTQ_RHO` overrides.
const RHO: f64 = 0.0;
pub fn rho() -> f64 {
    static R: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
    *R.get_or_init(|| std::env::var("SHOTQ_RHO").ok().and_then(|s| s.parse().ok()).unwrap_or(RHO).max(0.0))
}

/// Weight of the luminance term when the *remapper* picks the nearest palette entry; the design weight unless
/// `SHOTQ_LUMA_REMAP` overrides it (an experiment knob, P18). Measured on the real screenshots with the design
/// weight 4: remapping with 0 raises the RGB PSNR by 0.3-0.5 dB and halves the worst colour cast on two images, but
/// costs 0.5-2.3 dB of luma PSNR (typ_5k 47.2 -> 44.9): the palette's grey shades are then not used. 2.25 and 1 sit
/// in between. With fidelity first, the remapper keeps the design metric.
pub fn remap_luma() -> [f32; 3] {
    static L: std::sync::OnceLock<[f32; 3]> = std::sync::OnceLock::new();
    *L.get_or_init(|| std::env::var("SHOTQ_LUMA_REMAP").ok().and_then(|s| s.parse().ok()).map_or_else(luma, luma_coeffs))
}

fn luma_coeffs(k: f32) -> [f32; 3] {
    let s = k.max(0.0).sqrt();
    [0.2126 / W[0] * s, 0.7152 / W[1] * s, 0.0722 / W[2] * s]
}

pub struct ColorSpace { lut: [f32; 256], gamma: Option<f32> } // gamma: Some for the power curve (analytic inverse), None for PQ

/// The PQ curve of SMPTE ST 2084: a scale of absolute luminance (cd/m2) in which one step is about one just
/// noticeable difference at every level, derived from Barten's contrast sensitivity model. 0..1 over 0..10000 cd/m2.
fn pq(l: f64) -> f64 {
    let (m1, m2, c1, c2, c3) = (0.159_301_757_812_5, 78.84375, 0.835_937_5, 18.851_562_5, 18.6875);
    let y = (l / 10000.0).max(0.0).powf(m1);
    ((c1 + c2 * y) / (1.0 + c3 * y)).powf(m2)
}
fn srgb_linear(v: f64) -> f64 { if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) } }

impl ColorSpace {
    /// The channel curve: `SHOTQ_GAMMA` (default GAMMA) raises the code value to a power. `SHOTQ_CURVE=pq` (P26)
    /// takes the display into account instead: the code value's linear light times the display's peak luminance
    /// `SHOTQ_LPEAK` (cd/m2, default 500) plus the black level and veiling glare `SHOTQ_LBLACK` (default 0.5) is put
    /// on the PQ scale and normalised so that black is 0 and white is 1. A step near black is then worth as much as
    /// the eye can tell it apart from black, not as much as a power law says.
    pub fn new() -> Self {
        let mut lut = [0f32; 256];
        let mut gamma = None;
        if std::env::var("SHOTQ_CURVE").map_or(false, |c| c == "pq") {
            let peak: f64 = std::env::var("SHOTQ_LPEAK").ok().and_then(|s| s.parse().ok()).unwrap_or(500.0);
            let black: f64 = std::env::var("SHOTQ_LBLACK").ok().and_then(|s| s.parse().ok()).unwrap_or(0.5);
            let (lo, hi) = (pq(black), pq(peak + black));
            for (i, l) in lut.iter_mut().enumerate() { *l = ((pq(srgb_linear(i as f64 / 255.0) * peak + black) - lo) / (hi - lo)) as f32; }
        } else {
            let g: f32 = std::env::var("SHOTQ_GAMMA").ok().and_then(|s| s.parse().ok()).unwrap_or(GAMMA);
            for (i, l) in lut.iter_mut().enumerate() { *l = (i as f32 / 255.0).powf(g); }
            gamma = Some(g);
        }
        ColorSpace { lut, gamma }
    }

    /// Inverse of the channel curve: the 8-bit code (as a float, 0..255) whose curve value is `x`. Binary search on
    /// the monotone table plus linear interpolation; exact on the table's own values.
    pub fn decode(&self, x: f32) -> f32 {
        if let Some(g) = self.gamma { return x.clamp(0.0, 1.0).powf(1.0 / g) * 255.0; }
        if x <= self.lut[0] { return 0.0; }
        if x >= self.lut[255] { return 255.0; }
        let (mut lo, mut hi) = (0usize, 255usize);
        while hi - lo > 1 { let mid = (lo + hi) / 2; if self.lut[mid] <= x { lo = mid; } else { hi = mid; } }
        lo as f32 + (x - self.lut[lo]) / (self.lut[hi] - self.lut[lo])
    }

    #[inline(always)]
    fn chan(&self, v: f32) -> f32 {
        let v = v.clamp(0.0, 255.0);
        let i = v as usize;
        let f = v - i as f32;
        self.lut[i] + (self.lut[(i + 1).min(255)] - self.lut[i]) * f
    }

    #[inline(always)]
    pub fn conv(&self, r: u8, g: u8, b: u8, a: u8) -> [f32; 4] {
        let al = a as f32 / 255.0;
        [al, self.lut[r as usize] * W[0] * al, self.lut[g as usize] * W[1] * al, self.lut[b as usize] * W[2] * al]
    }

    #[inline(always)]
    pub fn conv_f(&self, r: f32, g: f32, b: f32, a: f32) -> [f32; 4] {
        let al = a / 255.0;
        [al, self.chan(r) * W[0] * al, self.chan(g) * W[1] * al, self.chan(b) * W[2] * al]
    }

    /// Inverse of `conv`, rounded to 8 bits.
    pub fn to_rgba(&self, v: [f32; 4]) -> Rgba {
        let al = v[0].clamp(0.0, 1.0);
        if al < 0.5 / 255.0 { return Rgba { r: 0, g: 0, b: 0, a: 0 }; }
        let to8 = |x: f32, w: f32| self.decode((x / (al * w)).clamp(0.0, 1.0)).round().clamp(0.0, 255.0) as u8;
        Rgba { r: to8(v[1], W[0]), g: to8(v[2], W[1]), b: to8(v[3], W[2]), a: (al * 255.0).round() as u8 }
    }
}

/// Colour difference: the weighted squared distance of the premultiplied colours (what is seen over black) plus
/// the squared luminance difference (scaled by LUMA_K), each term taking the larger of that and the difference seen
/// over white, where the channels also gain the transparency 1 - alpha. Two opaque colours get their plain weighted
/// squared distance plus the luminance term. Always >= the squared distance of the three colour components, which
/// is what the k-means pruning bound relies on.
#[inline(always)]
pub fn diff(p: &[f32; 4], q: &[f32; 4]) -> f32 { diff_with(p, q, luma()) }

/// The 0.8.0 difference, without the luminance term: for the reported quality and the `--quality` floor only.
#[inline(always)]
pub fn diff_report(p: &[f32; 4], q: &[f32; 4]) -> f32 { diff_with(p, q, [0.0; 3]) }

/// The difference with an explicit luminance weight vector (`luma()`, `remap_luma()` or zeros).
#[inline(always)]
pub fn diff_with(p: &[f32; 4], q: &[f32; 4], l: [f32; 3]) -> f32 {
    let al = q[0] - p[0];
    let (d1, d2, d3) = (p[1] - q[1], p[2] - q[2], p[3] - q[3]);
    // Equal alpha (two opaque colours, nearly always): the over-white terms are the over-black ones exactly
    // (d + 0.0 * w = d up to the sign of a zero, which the squares drop), so half the work is skipped (P44).
    if al == 0.0 {
        let lb = l[0] * d1 + l[1] * d2 + l[2] * d3;
        return d1 * d1 + d2 * d2 + d3 * d3 + lb * lb;
    }
    let (w1, w2, w3) = (d1 + al * W[0], d2 + al * W[1], d3 + al * W[2]);
    let (lb, lw) = (l[0] * d1 + l[1] * d2 + l[2] * d3, l[0] * w1 + l[1] * w2 + l[2] * w3);
    (d1 * d1).max(w1 * w1) + (d2 * d2).max(w2 * w2) + (d3 * d3).max(w3 * w3) + (lb * lb).max(lw * lw)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip() {
        let s = ColorSpace::new();
        let mut x = 12345u32;
        for _ in 0..200_000 {
            x = x.wrapping_mul(1664525).wrapping_add(1013904223);
            let [r, g, b, a] = x.to_le_bytes();
            let a = if a < 8 { 255 } else { a.max(40) }; // very low alpha cannot round-trip 8-bit colour
            let c = s.to_rgba(s.conv(r, g, b, a));
            let ok = |u: u8, v: u8| (u as i32 - v as i32).abs() <= if a == 255 { 0 } else { 4 };
            assert!(ok(c.r, r) && ok(c.g, g) && ok(c.b, b) && c.a == a, "{:?} -> {:?}", (r, g, b, a), c);
        }
    }

    #[test]
    fn diff_orders_colours_and_bounds_the_pruning() {
        let s = ColorSpace::new();
        let (black, white, grey) = (s.conv(0, 0, 0, 255), s.conv(255, 255, 255, 255), s.conv(128, 128, 128, 255));
        assert!(diff(&black, &white) > diff(&black, &grey) && diff(&black, &grey) > 0.0);
        assert_eq!(diff(&black, &black), 0.0);
        // a green step counts more than the same red or blue step
        let (dr, dg, db) = (diff(&black, &s.conv(10, 0, 0, 255)), diff(&black, &s.conv(0, 10, 0, 255)), diff(&black, &s.conv(0, 0, 10, 255)));
        assert!(dg > db && db > dr);
        // a grey step costs (2.25 + LUMA_K) times its square in curve units, a red step 0.5 + 0.045 LUMA_K
        let l = luma(); let k = (l[1] / 0.7152).powi(2);
        let g = s.lut[10];
        assert!((diff(&black, &s.conv(10, 10, 10, 255)) - (2.25 + k) * g * g).abs() < 1e-6, "grey step");
        assert!((dr - (0.5 + 0.2126f32.powi(2) * k) * g * g).abs() < 1e-6, "red step");
        // and the term is neutral to pure chroma at equal luminance: the bound still holds below
        // transparent black vs opaque black: identical over black, black vs white over white
        let clear = s.conv(0, 0, 0, 0);
        assert!((diff(&clear, &black) - (W[0] * W[0] + W[1] * W[1] + W[2] * W[2] + k)).abs() < 1e-5);
        assert!((diff_report(&clear, &black) - (W[0] * W[0] + W[1] * W[1] + W[2] * W[2])).abs() < 1e-5);
        assert!(diff_report(&black, &grey) < diff(&black, &grey), "the report metric has no luminance term");
        for (p, q) in [(&black, &white), (&clear, &black), (&grey, &s.conv(200, 30, 90, 128))] {
            let lb = (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2) + (p[3] - q[3]).powi(2);
            assert!(diff(p, q) >= lb - 1e-7);
        }
    }
}
