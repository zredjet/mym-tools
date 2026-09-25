//! Palette design without libimagequant.
//!
//! Structure follows what the colour-quantisation literature keeps finding (Celebi's 2023 survey): a fast *divisive*
//! method to get a good starting palette, then a *partitional* (k-means) refinement, with data reduction, sample
//! weighting and triangle-inequality pruning to make k-means cheap (Celebi's weighted sort-means, 2009/2011).
//!
//!   1. histogram   one entry per 6-bit colour cell (the same 262,144 cells the remapper uses), run-length aware;
//!                  exact colours of runs >= 4 samples are counted separately (flat UI colours in the same cell)
//!   2. split       Wu's variance-minimising box splitting on cumulative moments over a 129 x 47 x 47 grid of the
//!                  whitened design space with quantile-adjusted edges (P22-4C; 33^3 RGB until 0.10.0): cost independent of the
//!                  number of colours; translucent colours (rare in screenshots) are split as a 4-D point list;
//!                  one greedy loop picks the box with the largest error from either kind
//!   3. refine      weighted Lloyd iterations over the histogram entries; a point only looks at centres closer
//!                  than 2x its current distance to its own centre (exact, not approximate)
//!   4. rescue      while palette slots are spare, the bin with the largest own error (a small accent colour the
//!                  average-error stop never noticed) becomes a colour of its own; one more Lloyd step
//!   5. pin         flat colours seen in runs with >= 0.1% of the sample are points of their own (not cell means);
//!                  one that its cluster would shift by >= 3 levels inside its own cell (or that covers >= 1% of
//!                  the sample) gets a centre of its own and keeps exactly its colour
//!   6. snap        a cluster dominated by one colour gets exactly that colour (flat UI colours stay exact)
//!   7. report      weighted mean squared colour difference of the sample -> shotq's 0..100 quality, on the
//!                  0.8.0 metric without the luminance term (`diff_report`), so that the number and the --quality
//!                  floor keep their meaning while steps 2-4 design the palette against the stricter `diff`
//!
//! The final assignment of every histogram cell is handed to the remapper, which pre-fills its lookup table with it.

use crate::color::{diff, diff_report, diff_with, luma, luma_k, luma_unit, remap_luma, rho, ColorSpace, Rgba, W};
use rayon::prelude::*;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::atomic::{AtomicU16, Ordering};

pub const K_MAX: usize = 256;
/// In `Quantized::cells`: the cell holds points that went to different palette entries; the remapper must resolve
/// each pixel of that cell exactly (its `SLOW` marker).
pub const CELL_SLOW: u16 = 0xFFFE;
/// A run of at least this many identical consecutive samples (within one sample row) marks a flat area; only
/// such runs feed the exact-colour table, so anti-aliasing and noise never enter it.
pub const RUN_MIN: u32 = 4;
/// An exact colour seen in runs must carry at least this share of the sample to become a point of its own.
const EXACT_MIN: f32 = 0.001;
/// Translucent colours are counted in 2^18 cells of 4 bits per colour channel and 6 bits of alpha (a shadow is
/// black with a varying alpha, so alpha keeps the finer step). More distinct cells than this is noise, not a
/// screenshot: they are folded into coarser cells so that the splitting and k-means stay cheap.
const TRANS_MAX: usize = 4096;
/// An exact colour is pinned to a palette entry of its own only if the colour its cluster would produce differs
/// from it by at least this much in some channel (8-bit sRGB) and lies in the same 6-bit cell: two flat colours
/// 3 apart in one cell are exactly what the histogram cannot separate (#FFFFFF/#FCFCFC stripes, #000000 on
/// #030303). Differences of 1-2 are invisible, and pinning them costs bytes.
const PIN_MIN_DIFF: f32 = 3.0;
/// A flat colour with at least this share of the sample is pinned even when its cluster's colour lies in another
/// cell: a panel or background this large must not shift, however small the error metric says the shift is.
const PIN_BIG: f32 = 0.01;

pub struct Quantized {
    pub palette: Vec<Rgba>,
    pub quality: u8,
    /// (colour cell, palette index or `CELL_SLOW`) for every opaque colour cell present in the sample
    pub cells: Vec<(u32, u16)>,
    pub points: usize,
    /// Per palette entry: it holds an exact flat colour (pinned or snapped) that the remapper's palette correction
    /// (P20) must not move.
    pub locked: Vec<bool>,
}

struct Point {
    v: [f32; 4],    // clustering space
    rgba: [f32; 4], // mean sRGB of the bin (for exact snapping and for quality measurement)
    w: f32,         // sample count after the 10% weight cap: the weight of the quality report
    b: f32,         // mean context weight of the bin's samples (P24): `wd` = w * b is the weight of the palette design
    nf: f32,        // samples of the bin whose right or lower neighbour differs (not inside a flat run): the pixels that cost bits when their colour is split (P28)
    cell: u32, // u32::MAX for translucent bins
    cluster: u16,
    n: f32, // sample count of the bin, before the 10% weight cap
    d: f32, // error against its centre after the last assignment
    exact: bool, // one exact colour seen in flat runs (not a cell mean): may be pinned to a palette entry of its own
}
impl Point {
    /// The weight of a point in the divisive step, k-means, rescue and exchange: its capped sample count times the
    /// mean context weight of its samples (smooth gradients count CTX_SMOOTH times, flat areas and edges once).
    #[inline(always)] fn wd(&self) -> f64 { self.w as f64 * self.b as f64 }
}

// ---------------------------------------------------------------- quality scale (shotq's own)

/// Quality 85 stands for a mean squared weighted colour difference of 3.4e-4 over the (weighted) sample (a
/// root-mean-square difference of 0.0184 on the 0..1 channel scale); the target then grows linearly with (100 - q),
/// one fifteenth of that per point. Calibrated on the bench set (docs/HANDOFF.md P10, redone for the 1.3 curve in
/// P12 with tools/calibrate.py): with this scale `--quality 70-85` gives the colour counts (within a few) and the
/// pass/fail decisions that 0.3.0 gave on pngquant's scale. The corrected box-error bookkeeping of P14 calibrates
/// to 3.449e-4; the owner kept 3.4e-4 (docs/HANDOFF.md P14). `SHOTQ_QT85` overrides it for calibration runs.
const Q_T85: f64 = 3.4e-4;
fn q_t85() -> f64 { static V: std::sync::OnceLock<f64> = std::sync::OnceLock::new(); *V.get_or_init(|| std::env::var("SHOTQ_QT85").ok().and_then(|s| s.parse().ok()).unwrap_or(Q_T85)) }

/// Target mean squared colour difference for quality q (1..99): Q_T85 * (100 - q) / 15. 100 means no error at all,
/// 0 accepts anything.
pub fn quality_to_mse(q: u8) -> f64 {
    if q == 0 { return 1e20; }
    if q >= 100 { return 0.0; }
    q_t85() * (100.0 - q as f64) / 15.0
}

/// Quality of a finished remap over every pixel (no sampling, no weight cap): `raw` holds filter-None rows of
/// palette indices, as `remap` writes them. Diagnostic use. Reported on the 0.8.0 metric, like step 7.
pub fn image_quality(space: &ColorSpace, rgba: &[u8], pal: &[Rgba], raw: &[u8], w: usize) -> u8 {
    let pf: Vec<[f32; 4]> = pal.iter().map(|c| space.conv(c.r, c.g, c.b, c.a)).collect();
    let err: f64 = raw.par_chunks(w + 1).zip(rgba.par_chunks(w * 4)).map(|(row, px)| {
        row[1..].iter().zip(px.chunks_exact(4)).map(|(&i, p)| diff_report(&space.conv(p[0], p[1], p[2], p[3]), &pf[i as usize]) as f64).sum::<f64>()
    }).sum();
    mse_to_quality(err / (rgba.len() / 4) as f64)
}

fn kept_len(newidx: &[u16]) -> usize { newidx.iter().map(|&i| i as usize + 1).max().unwrap_or(0) }

pub fn mse_to_quality(mse: f64) -> u8 {
    (1..=100u8).rev().find(|&q| mse <= quality_to_mse(q) * (1.0 + 1e-6)).unwrap_or(0)
}

// ---------------------------------------------------------------- 1. histogram

#[derive(Default)]
struct MulHasher(u64);
impl Hasher for MulHasher {
    fn finish(&self) -> u64 { self.0 }
    fn write(&mut self, _: &[u8]) { unreachable!() }
    fn write_u32(&mut self, k: u32) { self.0 = (k as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15); }
    fn write_u64(&mut self, k: u64) { self.0 = (k ^ (k >> 29)).wrapping_mul(0x9E37_79B9_7F4A_7C15); }
}

/// Histogram accumulator. `push` is called once per sampled pixel; identical neighbours are counted as one run.
/// `end_row` must be called after every sample row, so that runs never cross rows: the per-thread bands are whole
/// rows, and the run lengths (which gate the exact-colour table) must not depend on how rows were divided.
pub struct Hist {
    cells: Vec<[u32; 5]>, // opaque: [count, sum of low 2 bits of r, g, b, sum of context weights]; the high 6 bits are the cell number itself
    nf: Option<Vec<u32>>, // opaque, per cell: non-flat samples, only with `SHOTQ_LAMBDA` (P28's rate term is its only reader; P45)
    tcells: Option<Vec<[u32; 5]>>, // translucent: [count, sum of low 4 bits of r, g, b, low 2 bits of a]; allocated on first use
    ttouched: Vec<u32>,
    exact: HashMap<u32, [u32; 3], BuildHasherDefault<MulHasher>>, // opaque colour -> [samples seen in runs of >= RUN_MIN, their context weights, non-flat ones]
    touched: Vec<u32>, // cells with a non-zero count, so that nobody has to scan all 262,144 afterwards
    last: u32,
    run: u32,
    run_b: u32, // context weights summed over the current run
    run_nf: u32, // non-flat samples in the current run
    total: usize,
    /// Banding statistics (P27, only with `SHOTQ_BAND`): opaque neighbour pairs that differ by exactly 1 level in
    /// some channel and at most 1 in every channel, as the two colours (lower key first), one entry per sampled
    /// pair (sorted and counted in `into_points`; a hash map per band and its merge cost 2 ms on tabby). Only
    /// locally smooth samples in every 8th sample column take part (`below` is Some; counted 8 times, the sort of
    /// the list is the cost): the sample's run end, if the earlier sample was smooth too, and the pixel below it.
    pairs: Vec<u64>,
    last_smooth: bool, // the earlier sample of this row was locally smooth (banding statistics)
}
/// Do two opaque colours differ by at most one code level in every channel (and at all)?
#[inline(always)]
fn near1(a: u32, b: u32) -> bool {
    if a == b { return false; }
    let (x, y) = (a.to_le_bytes(), b.to_le_bytes());
    x[3] == 255 && y[3] == 255 && (0..3).all(|c| (x[c] as i16 - y[c] as i16).abs() <= 1)
}

#[inline(always)]
fn tcell(r: u8, g: u8, b: u8, a: u8) -> usize { ((r as usize) >> 4) << 14 | ((g as usize) >> 4) << 10 | ((b as usize) >> 4) << 6 | (a as usize) >> 2 }

impl Hist {
    pub fn new() -> Self {
        Hist { cells: vec![[0u32; 5]; 1 << 18], nf: (lambda85() > 0.0).then(|| vec![0u32; 1 << 18]), tcells: None, ttouched: Vec::new(), exact: HashMap::with_capacity_and_hasher(1024, Default::default()),
               touched: Vec::with_capacity(1 << 16), last: 0, run: 0, run_b: 0, run_nf: 0, total: 0, pairs: Vec::new(), last_smooth: false }
    }

    #[inline(always)]
    pub fn end_row(&mut self) { self.flush(); self.last_smooth = false; }

    #[cfg(test)]
    pub fn push(&mut self, k: u32) { self.push_w(k, crate::CTX_FP, 1, false, None) }

    /// SHOTQ_PAIR_RIGHT=1 (P39, experiment): the horizontal banding pair is the sample and the pixel to its right
    /// (read anyway for the context weight) instead of the previous sample, which at a sampling step above 1 is
    /// neither adjacent nor, across a segment boundary, on the same row (the owner counted 96% non-adjacent).
    pub fn pair_right() -> bool {
        static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *V.get_or_init(|| std::env::var("SHOTQ_PAIR_RIGHT").map_or(false, |s| s == "1"))
    }

    /// One sample with its context weight (P24: CTX_SMOOTH for a pixel inside a smooth gradient, 1 otherwise) and
    /// whether it is non-flat (a neighbour differs; P28's rate estimate).
    #[inline(always)]
    pub fn push_w(&mut self, k: u32, b: u32, nf: u32, smooth: bool, pair: Option<(u32, u32)>) {
        // `smooth` is false and `pair` None for every sample unless the banding rule is on: nothing to do by default
        if smooth || self.last_smooth {
            if let Some((below, right)) = pair {
                if near1(k, below) { self.pairs.push(((k.min(below) as u64) << 32) | k.max(below) as u64); }
                if Self::pair_right() { if near1(k, right) { self.pairs.push(((k.min(right) as u64) << 32) | k.max(right) as u64); } }
                else if self.run > 0 && self.last_smooth && near1(self.last, k) { self.pairs.push(((k.min(self.last) as u64) << 32) | k.max(self.last) as u64); }
            }
            self.last_smooth = smooth;
        }
        if k == self.last && self.run > 0 { self.run += 1; self.run_b += b; self.run_nf += nf; return; }
        self.flush();
        self.last = k; self.run = 1; self.run_b = b; self.run_nf = nf;
    }

    #[inline(always)]
    fn flush(&mut self) {
        let run = self.run;
        if run == 0 { return; }
        self.total += run as usize;
        let [r, g, b, a] = self.last.to_le_bytes();
        if a == 255 {
            let cell = ((r as usize) >> 2) << 12 | ((g as usize) >> 2) << 6 | (b as usize) >> 2;
            let c = &mut self.cells[cell];
            if c[0] == 0 { self.touched.push(cell as u32); }
            c[0] += run; c[1] += (r & 3) as u32 * run; c[2] += (g & 3) as u32 * run; c[3] += (b & 3) as u32 * run; c[4] += self.run_b;
            if let Some(nf) = &mut self.nf { nf[cell] += self.run_nf; }
            if run >= RUN_MIN { let e = self.exact.entry(self.last).or_insert([0, 0, 0]); e[0] += run; e[1] += self.run_b; e[2] += self.run_nf; }
        } else {
            let (r, g, b) = if a == 0 { (0, 0, 0) } else { (r, g, b) };
            let cell = tcell(r, g, b, a);
            let c = &mut self.tcells.get_or_insert_with(|| vec![[0u32; 5]; 1 << 18])[cell];
            if c[0] == 0 { self.ttouched.push(cell as u32); }
            c[0] += run; c[1] += (r & 15) as u32 * run; c[2] += (g & 15) as u32 * run; c[3] += (b & 15) as u32 * run; c[4] += (a & 3) as u32 * run;
        }
        self.run = 0;
    }

    /// Adds another thread's histogram. Costs one step per *touched* cell, not per table entry, and the result
    /// does not depend on how the rows were divided among threads.
    pub fn merge(mut self, mut other: Hist) -> Hist {
        self.flush();
        other.flush();
        for &cell in &other.touched {
            let (c, o) = (&mut self.cells[cell as usize], other.cells[cell as usize]);
            if c[0] == 0 { self.touched.push(cell); }
            for d in 0..5 { c[d] += o[d]; }
        }
        if let (Some(a), Some(o)) = (&mut self.nf, &other.nf) { for &cell in &other.touched { a[cell as usize] += o[cell as usize]; } }
        if let Some(o) = other.tcells {
            match &mut self.tcells {
                None => { self.tcells = Some(o); self.ttouched = other.ttouched; }
                Some(t) => for &cell in &other.ttouched {
                    let (c, oc) = (&mut t[cell as usize], o[cell as usize]);
                    if c[0] == 0 { self.ttouched.push(cell); }
                    for d in 0..5 { c[d] += oc[d]; }
                },
            }
        }
        for (k, o) in other.exact { let e = self.exact.entry(k).or_insert([0, 0, 0]); e[0] += o[0]; e[1] += o[1]; e[2] += o[2]; }
        self.pairs.extend_from_slice(&other.pairs);
        self.total += other.total;
        self
    }

    /// Opaque points (one per cell mean, plus one per significant exact colour, which is taken out of its cell's
    /// mean), translucent points, total sample count, and the recorded colour pairs as they are (P45: mapped to
    /// point pairs by `pairs_to_points` when the banding rule first needs them). Order is deterministic.
    fn into_points(mut self, space: &ColorSpace) -> (Vec<Point>, Vec<Point>, usize, Vec<u64>) {
        self.flush();
        self.touched.sort_unstable(); // deterministic order, independent of where colours first appear
        // Flat colours with enough weight leave their cell: a cell then holds e.g. #030303 (a panel) and #000000
        // (a black block) as two points instead of one mean of 2.9. Which colours qualify depends only on counts.
        let min = ((EXACT_MIN * self.total as f32) as u32).max(RUN_MIN);
        let mut exact: Vec<(u32, [u32; 3])> = self.exact.iter().filter(|&(_, &e)| e[0] >= min).map(|(&k, &e)| (k, e)).collect();
        exact.sort_unstable();
        for &(k, [n, nb, nnf]) in &exact {
            let [r, g, b, _] = k.to_le_bytes();
            let ci = ((r as usize) >> 2) << 12 | ((g as usize) >> 2) << 6 | (b as usize) >> 2;
            let c = &mut self.cells[ci];
            c[0] -= n; c[1] -= (r & 3) as u32 * n; c[2] -= (g & 3) as u32 * n; c[3] -= (b & 3) as u32 * n; c[4] -= nb; // all counted there before
            if let Some(nf) = &mut self.nf { nf[ci] -= nnf; }
        }
        let (cells, nfs) = (&self.cells, self.nf.as_deref());
        let mut opaque: Vec<Point> = self.touched.par_iter().filter(|&&cell| cells[cell as usize][0] > 0).map(|&cell| {
            let c = cells[cell as usize];
            let n = c[0] as f32;
            let rgba = [((cell >> 12) << 2) as f32 + c[1] as f32 / n, ((cell >> 6 & 63) << 2) as f32 + c[2] as f32 / n,
                        ((cell & 63) << 2) as f32 + c[3] as f32 / n, 255.0];
            Point { v: space.conv_f(rgba[0], rgba[1], rgba[2], 255.0), rgba, w: n, b: c[4] as f32 / (crate::CTX_FP as f32 * n), nf: nfs.map_or(0.0, |v| v[cell as usize] as f32), cell, cluster: 0, n, d: 0.0, exact: false }
        }).collect();
        opaque.extend(exact.iter().map(|&(k, [n, nb, nnf])| {
            let [r, g, b, _] = k.to_le_bytes();
            let cell = ((r as u32) >> 2) << 12 | ((g as u32) >> 2) << 6 | (b as u32) >> 2;
            Point { v: space.conv(r, g, b, 255), rgba: [r as f32, g as f32, b as f32, 255.0], w: n as f32, b: nb as f32 / (crate::CTX_FP as f32 * n as f32), nf: nnf as f32, cell, cluster: 0, n: n as f32, d: 0.0, exact: true }
        }));
        let translucent: Vec<Point> = self.translucent_bins().into_iter().map(|(n, s)| {
            let n = n as f32;
            let rgba = [s[0] as f32 / n, s[1] as f32 / n, s[2] as f32 / n, s[3] as f32 / n];
            Point { v: space.conv_f(rgba[0], rgba[1], rgba[2], rgba[3]), rgba, w: n, b: 1.0, nf: n, cell: u32::MAX, cluster: 0, n, d: 0.0, exact: false }
        }).collect();
        (opaque, translucent, self.total, self.pairs)
    }
}

/// The recorded colour pairs as (opaque point, opaque point, count), and the count over all of them: a colour is
/// its exact point if it has one, otherwise its cell's point; pairs inside one point are dropped; sorted, so the
/// order is deterministic. `opaque` in the order `into_points` returned it (the point numbers refer to it).
fn pairs_to_points(mut raw: Vec<u64>, opaque: &[Point]) -> (Vec<(u32, u32, u32)>, f64) {
    let mut pairs: Vec<(u32, u32, u32)> = Vec::new();
    if !raw.is_empty() {
        raw.par_sort_unstable();
        let mut cell_idx = vec![u32::MAX; 1 << 18];
        let mut exact_idx: HashMap<u32, u32, BuildHasherDefault<MulHasher>> = HashMap::default();
        for (i, p) in opaque.iter().enumerate() {
            if p.exact { exact_idx.insert(u32::from_le_bytes([p.rgba[0] as u8, p.rgba[1] as u8, p.rgba[2] as u8, 255]), i as u32); } else { cell_idx[p.cell as usize] = i as u32; }
        }
        let idx = |k: u32| -> u32 {
            if let Some(&i) = exact_idx.get(&k) { return i; }
            let [r, g, b, _] = k.to_le_bytes();
            cell_idx[((r as usize) >> 2) << 12 | ((g as usize) >> 2) << 6 | (b as usize) >> 2]
        };
        let (mut i, mut keyed): (usize, Vec<u64>) = (0, Vec::new());
        while i < raw.len() {
            let key = raw[i];
            let mut j = i + 1;
            while j < raw.len() && raw[j] == key { j += 1; }
            let (a, b) = (idx((key >> 32) as u32), idx(key as u32));
            // point pair and count packed in one key: 20 bits each for the points (< 2^18 cells + exact colours), 24 for the count
            if a != u32::MAX && b != u32::MAX && a != b { keyed.push(((a.min(b) as u64) << 44) | ((a.max(b) as u64) << 24) | (8 * (j - i) as u64).min((1 << 24) - 1)); }
            i = j;
        }
        keyed.sort_unstable(); // two colour pairs can map to one point pair; the order of the list is what matters
        // ... and then they are one record with the counts added (P44: 53-86% fewer records on the real
        // images). The consumers only add and subtract the counts, integers that are exact in f64, so the
        // banding sums are the same as with one record per colour pair.
        pairs.reserve(keyed.len());
        for &k in &keyed {
            let (a, b, n) = ((k >> 44) as u32, ((k >> 24) & 0xF_FFFF) as u32, (k & 0xFF_FFFF) as u32);
            match pairs.last_mut() { Some(l) if l.0 == a && l.1 == b => l.2 += n, _ => pairs.push((a, b, n)) }
        }
    }
    let total = pairs.iter().map(|p| p.2 as f64).sum();
    (pairs, total)
}

/// The banding rule's pairs (P27): colour pairs as recorded, mapped to point pairs on first need (P45: an image
/// that splits to 256 colours before meeting the error target never sorts them). `Points` also holds the count
/// over all pairs before any was dropped (the pre-pin path drops pairs; the banding score keeps its scale).
enum Pairs { Raw(Vec<u64>), Points { pairs: Vec<(u32, u32, u32)>, total: f64 } }
impl Pairs {
    fn is_empty(&self) -> bool { self.len() == 0 }
    fn len(&self) -> usize { match self { Pairs::Raw(v) => v.len(), Pairs::Points { pairs, .. } => pairs.len() } }
    /// The point pairs and their total, converting once. `opaque` in the order `into_points` returned it.
    fn resolve(&mut self, opaque: &[Point]) -> (&[(u32, u32, u32)], f64) {
        if let Pairs::Raw(raw) = self { let (pairs, total) = pairs_to_points(std::mem::take(raw), opaque); *self = Pairs::Points { pairs, total }; }
        match self { Pairs::Points { pairs, total } => (pairs, *total), Pairs::Raw(_) => unreachable!() }
    }
}

impl Hist {
    /// Translucent bins as (count, sums of r, g, b, a), in cell order. Cells are folded to fewer bits (colour first,
    /// then alpha) while there are more than TRANS_MAX of them; every step is a pure function of the merged counts,
    /// so the result does not depend on how the rows were divided among threads.
    fn translucent_bins(&mut self) -> Vec<(u64, [u64; 4])> {
        let Some(t) = &self.tcells else { return Vec::new() };
        let sums = |cell: u32| {
            let (c, e) = (cell as u64, t[cell as usize]);
            let n = e[0] as u64;
            (n, [((c >> 14) << 4) * n + e[1] as u64, ((c >> 10 & 15) << 4) * n + e[2] as u64, ((c >> 6 & 15) << 4) * n + e[3] as u64, ((c & 63) << 2) * n + e[4] as u64])
        };
        let mut bits = [4u32, 4, 4, 6]; // per channel, current key layout (r, g, b, a)
        let mut bins: Vec<(u32, u64, [u64; 4])> = if self.ttouched.len() <= TRANS_MAX {
            self.ttouched.sort_unstable();
            self.ttouched.iter().map(|&cell| { let (n, s) = sums(cell); (cell, n, s) }).collect()
        } else { // first fold straight from the table: 4,4,4,6 -> 3,3,3,6 bits, in cell order by construction
            let mut dense = vec![(0u64, [0u64; 4]); 1 << 15];
            for &cell in &self.ttouched {
                let (n, s) = sums(cell);
                let k = ((cell >> 15) << 12 | (cell >> 11 & 7) << 9 | (cell >> 7 & 7) << 6 | cell & 63) as usize;
                dense[k].0 += n;
                for d in 0..4 { dense[k].1[d] += s[d]; }
            }
            bits = [3, 3, 3, 6];
            dense.into_iter().enumerate().filter(|(_, (n, _))| *n > 0).map(|(k, (n, s))| (k as u32, n, s)).collect()
        };
        while bins.len() > TRANS_MAX && bits[0] > 1 {
            let nb = [bits[0] - 1, bits[1] - 1, bits[2] - 1, if bits[0] < 4 { bits[3] - 1 } else { bits[3] }];
            let mut dense = vec![(0u64, [0u64; 4]); 1 << (nb[0] + nb[1] + nb[2] + nb[3])];
            for &(key, n, s) in &bins {
                let (r, g, b, a) = (key >> (bits[1] + bits[2] + bits[3]), key >> (bits[2] + bits[3]) & ((1 << bits[1]) - 1), key >> bits[3] & ((1 << bits[2]) - 1), key & ((1 << bits[3]) - 1));
                let k = ((r >> (bits[0] - nb[0])) << (nb[1] + nb[2] + nb[3]) | (g >> (bits[1] - nb[1])) << (nb[2] + nb[3]) | (b >> (bits[2] - nb[2])) << nb[3] | a >> (bits[3] - nb[3])) as usize;
                dense[k].0 += n;
                for d in 0..4 { dense[k].1[d] += s[d]; }
            }
            bins = dense.into_iter().enumerate().filter(|(_, (n, _))| *n > 0).map(|(k, (n, s))| (k as u32, n, s)).collect();
            bits = nb;
        }
        bins.into_iter().map(|(_, n, s)| (n, s)).collect()
    }
}

// ---------------------------------------------------------------- 2. divisive initialisation

type M = [f64; 6]; // weight, sum x, sum y, sum z, sum |v|^2, sum (luminance of v)^2
#[inline(always)] fn sub(a: M, b: M) -> M { [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3], a[4] - b[4], a[5] - b[5]] }
// The cumulative table keeps the first four moments (what every cut candidate reads) apart from the two squared
// sums (read only for the variance of a chosen box), P38: half the bytes per cell in the cut search.
type M4 = [f64; 4]; type M2 = [f64; 2];
#[inline(always)] fn add4(a: M4, b: M4) -> M4 { [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]] }
#[inline(always)] fn sub4(a: M4, b: M4) -> M4 { [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]] }
#[inline(always)] fn add2(a: M2, b: M2) -> M2 { [a[0] + b[0], a[1] + b[1]] }
#[inline(always)] fn sub2(a: M2, b: M2) -> M2 { [a[0] - b[0], a[1] - b[1]] }
/// Bits a split adds to the index map, estimated from the non-flat samples of the box (the ones a neighbour
/// differs from, so their symbols change along a row): the zero-order entropy of splitting `n` such samples into
/// `a` and `n - a`. Flat runs cost nothing whichever colour they get (P28).
#[inline(always)] fn split_bits(n: f64, a: f64) -> f64 {
    let b = n - a;
    if a <= 0.0 || b <= 0.0 { return 0.0; }
    a * (n / a).log2() + b * (n / b).log2()
}
/// Rate-distortion mode (P28): with LAMBDA > 0 the divisive step cuts the box with the largest
/// `error reduction - lambda * added bits` and stops when no cut is worth its bits, instead of cutting the box
/// with the largest error until the average meets the `--quality` target. `SHOTQ_LAMBDA` sets the value at
/// quality 85; it scales with (100 - q) / 15 like the target. 0 = the target rule. Measured and not adopted
/// (HANDOFF P28): with this rate model gradients, whose every pixel is non-flat, are the most expensive place to
/// spend a colour, so the rule takes colours from them and gives them to text-heavy light UI; at equal bytes the
/// RGB PSNR is a little higher but false contours, colour casts and the neutral-pixel luma are worse.
const LAMBDA85: f64 = 0.0;
fn lambda85() -> f64 { static V: std::sync::OnceLock<f64> = std::sync::OnceLock::new(); *V.get_or_init(|| knob("SHOTQ_LAMBDA", LAMBDA85).max(0.0)) }
#[inline(always)] fn lum(x: f64, y: f64, z: f64) -> f64 { let l = luma_unit(); l[0] as f64 * x + l[1] as f64 * y + l[2] as f64 * z }
/// The quadratic form of `diff` for opaque colours: |v|^2 plus LUMA_K times the squared luminance. The split score
/// uses it, so the divisive step measures the same error as k-means.
#[inline(always)] fn q2(x: f64, y: f64, z: f64) -> f64 { x * x + y * y + z * z + luma_k() as f64 * lum(x, y, z).powi(2) }
/// A box's (reference variance, luminance variance): the design variance is ref + LUMA_K * lum.
#[inline(always)] fn variances(s: M) -> (f64, f64) {
    if s[0] <= 0.0 { return (0.0, 0.0); }
    ((s[4] - (s[1] * s[1] + s[2] * s[2] + s[3] * s[3]) / s[0]).max(0.0), (s[5] - lum(s[1], s[2], s[3]).powi(2) / s[0]).max(0.0))
}
/// Is a box "neutral" for the luminance stop test: its mean colour has a chroma (max - min of the 8-bit code
/// values) of at most NEUTRAL_CODE. Grey UI, text and gradients count; a photograph's boxes do not dilute them.
const NEUTRAL_CODE: f64 = 8.0;
fn is_neutral(mean: &[f64; 4], space: &ColorSpace) -> bool {
    if mean[0] <= 0.0 { return false; }
    let code = |d: usize| space.decode((mean[d + 1] / (mean[0] * W[d] as f64)).clamp(0.0, 1.0) as f32) as f64;
    let (r, g, b) = (code(0), code(1), code(2));
    r.max(g).max(b) - r.min(g).min(b) <= NEUTRAL_CODE
}
/// Legacy knob: `SHOTQ_WU_BITS=b` puts Wu's grid on the R, G, B code axes with 2^b uniform bins each (6 = the 64
/// histogram cells, the 0.11.0-0.15.0 grid; 5 = 32 bins of 8 code levels, the grid before 0.11.0). Since 0.16.0
/// the default grid is the whitened one below (`grid_cfg`).
#[allow(dead_code)] const WU_BITS: u32 = 6;
/// The divisive stop target and the rescue threshold are `quality_to_mse(qmax)` times this (P22). A finer grid
/// alone gives smaller files at a lower PSNR, so each grid change re-scales the target to keep the bytes of the
/// real screenshots at `--quality 85`: 2/3 for the 65^3 cell grid of 0.11.0 (85 on the 0.10.0 grid ~ 90), and
/// 8/15 (= 2/3 * 12/15: the old 88) for the whitened grid of 0.16.0 (P22-4C). The reported quality and the
/// `--quality` floor keep their scale. `SHOTQ_STOP` overrides (0.6667 with `SHOTQ_WU_BITS=6` is 0.15.0 exactly).
const STOP_SCALE: f64 = 8.0 / 15.0;
fn stop_scale() -> f64 {
    static V: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
    *V.get_or_init(|| std::env::var("SHOTQ_STOP").ok().and_then(|s| s.parse().ok()).unwrap_or(STOP_SCALE).max(0.0))
}
/// Wu's grid over the whitened design space (4B): `SHOTQ_WU_GRID=LxC` bins the luminance axis into L and each
/// chroma axis into C bins. For opaque colours `diff` is |d|^2 + LUMA_K (l . d)^2 = |d_perp|^2 +
/// (1 + LUMA_K |l|^2) |d_par|^2, d_par being the component along the luminance direction, so with that axis scaled
/// by s = sqrt(1 + LUMA_K |l|^2) and two orthonormal chroma axes the design metric is plain Euclidean and the cuts
/// are perpendicular to luminance or to a chroma axis instead of to R, G or B. Alone (uniform edges, HANDOFF
/// P22-4B) it met the target with fewer boxes (a noisy grey ramp 114 -> 89) and at equal bytes gained 0.2 dB RGB
/// but lost 0.2 dB on neutral pixels and 10% on false contours: near-white panels lost the 1-level shades that the
/// cell grid kept as spare boxes. The quantile edges of 4C give those shades their own bins, and the combination
/// is the 0.16.0 default (`grid_cfg`).
fn wu_grid() -> Option<(usize, usize)> {
    static V: std::sync::OnceLock<Option<(usize, usize)>> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        let s = std::env::var("SHOTQ_WU_GRID").ok()?;
        let (l, c) = s.split_once('x')?;
        Some((l.trim().parse::<usize>().ok()?.clamp(2, 1024), c.trim().parse::<usize>().ok()?.clamp(2, 1024)))
    })
}
/// Wu's grid (0.16.0, P22-4B + 4C). Default: the whitened axes (luminance, two chroma axes; see `wu_grid`) in code
/// space, 129 luminance by 47^2 chroma bins, with each axis' bin edges halfway between the uniform positions and
/// the weighted quantiles of the points (`q` = 0.5), so that the cuts can fall where the image has its mass:
/// between two heavy shades one code level apart, or inside the dark end that the curve compresses. Measured at
/// equal bytes against the 65^3 cell grid (HANDOFF P22-4C): real screenshots RGB +0.45 dB, luma +0.3 dB,
/// false contours -3%, ramps -11% bytes at the same luma; +0.5 ms at 5K. Knobs: `SHOTQ_WU_GRID=LxC` (bins),
/// `SHOTQ_WU_CODE=0` (curve space: coarser than the cells in the dark, rejected), `SHOTQ_WU_Q` (0 = uniform,
/// 1 = pure quantiles), `SHOTQ_WU_QU` (below), `SHOTQ_WU_RGB=N` or `SHOTQ_WU_BITS=b` (the R, G, B code axes with
/// N = 2^b bins each: 64 uniform bins are the histogram cells, the grid of 0.11.0-0.15.0).
/// `qu[a]` > 0 instead keeps the uniform edges and adds that many quantile edges on axis a (the union: no
/// resolution is lost anywhere, the grid grows by `qu[a]` bins on that axis; `SHOTQ_WU_QU=L` or `L,C`: for the
/// whitened grid L on the luminance axis and C on both chroma axes, for the RGB grid L on all three).
#[derive(Clone, Copy)]
struct GridCfg { bins: [usize; 3], rgb: bool, code: bool, q: f64, qu: [usize; 3] }
const WU_GRID: (usize, usize) = (129, 47);
const WU_Q: f64 = 0.5;
fn grid_cfg() -> GridCfg {
    static V: std::sync::OnceLock<GridCfg> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        let q = knob("SHOTQ_WU_Q", WU_Q).clamp(0.0, 1.0);
        let qu: Vec<usize> = std::env::var("SHOTQ_WU_QU").ok().map(|s| s.split(',').filter_map(|x| x.trim().parse::<usize>().ok()).map(|x| x.min(1024)).collect()).unwrap_or_default();
        let (ql, qc) = (qu.first().copied().unwrap_or(0), qu.get(1).copied().unwrap_or(0));
        let rgb_bins = std::env::var("SHOTQ_WU_RGB").ok().and_then(|s| s.trim().parse::<usize>().ok())
            .or_else(|| std::env::var("SHOTQ_WU_BITS").ok().and_then(|s| s.parse::<u32>().ok()).map(|b| 1usize << b.clamp(1, 6)));
        if let Some(n) = rgb_bins {
            return GridCfg { bins: [n.clamp(2, 1024); 3], rgb: true, code: true, q: knob("SHOTQ_WU_Q", 0f64).clamp(0.0, 1.0), qu: [ql; 3] };
        }
        let (l, c) = wu_grid().unwrap_or(WU_GRID);
        GridCfg { bins: [l, c, c], rgb: false, code: knob("SHOTQ_WU_CODE", 1u8) != 0, q, qu: [ql, qc, qc] }
    })
}
/// The grid's axes, the range of each over the opaque colour box, and a lookup table per axis from a coordinate
/// slot (the range in SLOTS equal parts) to the number of bin edges at or below it. Edges lie on slot boundaries:
/// uniform edges of 64 bins over the code box fall exactly on the cell boundaries, a blended or quantile edge is
/// rounded to the nearest boundary (1/4096 of the range, 0.06 code levels). A binary search per axis instead of
/// the table cost 1 ms at 5K.
struct Aniso { axis: [[f64; 3]; 3], lo: [f64; 3], scale: [f64; 3], bins: [usize; 3], code: bool, lut: [Vec<u16>; 3] }
const SLOTS: usize = 4096;
impl Aniso {
    /// The grid and the slots of every point (computed once: the moments and the final tagging reuse them).
    fn new(cfg: GridCfg, points: &[Point]) -> (Self, Vec<[u16; 3]>) {
        let (bins, code) = (cfg.bins, cfg.code);
        let axis = if cfg.rgb { [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]] } else {
            let l = if code { [0.2126, 0.7152, 0.0722] } else { luma_unit().map(|x| x as f64) };
            let n2 = l[0] * l[0] + l[1] * l[1] + l[2] * l[2];
            let s = if code { 1.0 } else { (1.0 + luma_k() as f64 * n2).sqrt() };
            let lhat = l.map(|x| x / n2.sqrt());
            let e1 = { let n = (lhat[0] * lhat[0] + lhat[1] * lhat[1]).sqrt(); [lhat[1] / n, -lhat[0] / n, 0.0] }; // red - green
            let e2 = [lhat[1] * e1[2] - lhat[2] * e1[1], lhat[2] * e1[0] - lhat[0] * e1[2], lhat[0] * e1[1] - lhat[1] * e1[0]]; // ~ blue - yellow
            [lhat.map(|x| x * s), e1, e2]
        };
        let (mut lo, mut hi) = ([f64::MAX; 3], [f64::MIN; 3]);
        // the code box is [0, 256) so that uniform edges at multiples of 256 / N are the cell boundaries
        let top = if cfg.rgb { [256.0; 3] } else if code { [255.0; 3] } else { W.map(|x| x as f64) };
        for corner in 0..8 {
            let v = [if corner & 1 != 0 { top[0] } else { 0.0 }, if corner & 2 != 0 { top[1] } else { 0.0 }, if corner & 4 != 0 { top[2] } else { 0.0 }];
            for a in 0..3 { let t = axis[a][0] * v[0] + axis[a][1] * v[1] + axis[a][2] * v[2]; lo[a] = lo[a].min(t); hi[a] = hi[a].max(t); }
        }
        let scale = [0, 1, 2].map(|a| SLOTS as f64 / (hi[a] - lo[a]));
        let mut grid = Aniso { axis, lo, scale, bins, code, lut: [Vec::new(), Vec::new(), Vec::new()] };
        let quantiles = cfg.q > 0.0 || cfg.qu.iter().any(|&x| x > 0);
        let slots: Vec<[u16; 3]> = points.iter().map(|p| grid.slots(p).map(|x| x as u16)).collect();
        // weighted histogram of each coordinate over the slots (only when quantile edges are asked for)
        let mut hist = vec![[0f64; SLOTS]; if quantiles { 3 } else { 0 }];
        let mut total = 0f64;
        if quantiles {
            for (p, sl) in points.iter().zip(&slots) {
                total += p.wd();
                for a in 0..3 { hist[a][sl[a] as usize] += p.wd(); }
            }
        }
        for a in 0..3 {
            let uni = |i: usize, n: usize| i as f64 * SLOTS as f64 / n as f64; // edge position in slot units
            let (mut cum, mut slot) = (0f64, 0usize);
            let mut quant = |want: f64| { // ascending calls only
                while slot < SLOTS - 1 && cum + hist[a][slot] < want { cum += hist[a][slot]; slot += 1; }
                let frac = if hist[a][slot] > 0.0 { ((want - cum) / hist[a][slot]).clamp(0.0, 1.0) } else { 0.0 };
                slot as f64 + frac
            };
            let mut edges: Vec<usize> = if cfg.q > 0.0 {
                (1..bins[a]).map(|i| ((1.0 - cfg.q) * uni(i, bins[a]) + cfg.q * quant(total * i as f64 / bins[a] as f64)).round() as usize).collect()
            } else {
                let mut e: Vec<usize> = (1..bins[a]).map(|i| uni(i, bins[a]).round() as usize).collect();
                e.extend((1..=cfg.qu[a]).map(|j| quant(total * j as f64 / (cfg.qu[a] + 1) as f64).round() as usize));
                e
            };
            edges.retain(|&k| k > 0 && k < SLOTS);
            edges.sort_unstable();
            edges.dedup();
            // lut[s] = edges at or below slot s
            let mut lut = vec![0u16; SLOTS];
            let (mut n, mut e) = (0u16, 0usize);
            for (sl, out) in lut.iter_mut().enumerate() { while e < edges.len() && edges[e] <= sl { e += 1; n += 1; } *out = n; }
            grid.bins[a] = edges.len() + 1;
            grid.lut[a] = lut;
        }
        (grid, slots)
    }
    /// The slot of each coordinate of a point.
    #[inline(always)] fn slots(&self, p: &Point) -> [usize; 3] {
        let v = if self.code { [p.rgba[0], p.rgba[1], p.rgba[2]] } else { [p.v[1], p.v[2], p.v[3]] };
        [0, 1, 2].map(|a| {
            let t = self.axis[a][0] * v[0] as f64 + self.axis[a][1] * v[1] as f64 + self.axis[a][2] * v[2] as f64;
            (((t - self.lo[a]) * self.scale[a]).floor().max(0.0) as usize).min(SLOTS - 1)
        })
    }
    #[inline(always)] fn bin(&self, sl: [u16; 3]) -> (usize, usize, usize) {
        (self.lut[0][sl[0] as usize] as usize + 1, self.lut[1][sl[1] as usize] as usize + 1, self.lut[2][sl[2] as usize] as usize + 1)
    }
}

#[derive(Clone, Copy)]
struct Cube { lo: [usize; 3], hi: [usize; 3] } // cells (lo, hi] per axis, as in Wu's paper

/// `nf`: cumulative non-flat sample counts, built only in rate-distortion mode (P28) so that the default path pays
/// nothing for it (a seventh moment cost 0.3 ms at 5K).
struct Wu { m4: Vec<M4>, m2: Vec<M2>, nf: Option<Vec<f64>>, n: [usize; 3], grid: Aniso, slots: Vec<[u16; 3]> }

impl Wu {
    #[inline(always)] fn gx(&self, r: usize, g: usize, b: usize) -> usize { (r * self.n[1] + g) * self.n[2] + b }
    /// The grid bin (1-based, as in Wu's paper) of point `i`, from its slots on the grid's axes.
    #[inline(always)] fn bin(&self, i: usize) -> (usize, usize, usize) { self.grid.bin(self.slots[i]) }
    fn new(points: &[Point], with_rate: bool) -> Self {
        let (mut grid, slots) = Aniso::new(grid_cfg(), points);
        // Grid coordinates no point falls into are dropped from the table (P38): the owner's screenshots use about
        // half of the 130 x 48 x 48 cells' coordinates, so the cumulative table and its first touch halve. The
        // partitions the cuts can produce are the same (a cut at an empty coordinate equals the cut at the used
        // one before it, and the first of equal scores wins either way), and the sums are bit-identical (the
        // dropped cells added exact zeros).
        let full = grid.bins;
        for a in 0..3 {
            let mut used = vec![false; grid.bins[a]];
            for sl in &slots { used[grid.lut[a][sl[a] as usize] as usize] = true; }
            let (mut rank, mut k) = (vec![0u16; grid.bins[a]], 0u16);
            for (i, &u) in used.iter().enumerate() { rank[i] = k; if u { k += 1; } }
            for v in grid.lut[a].iter_mut() { *v = rank[*v as usize]; }
            grid.bins[a] = k as usize;
        }
        if std::env::var_os("SHOTQ_DEBUG").is_some() { eprintln!("  quant: wu grid {}x{}x{} -> {}x{}x{} used coordinates", full[0], full[1], full[2], grid.bins[0], grid.bins[1], grid.bins[2]); }
        let mut wu = Wu { m4: Vec::new(), m2: Vec::new(), nf: None, n: [grid.bins[0] + 1, grid.bins[1] + 1, grid.bins[2] + 1], grid, slots };
        let n = wu.n;
        let cells = n[0] * n[1] * n[2];
        let (mut m4, mut m2) = (vec![[0f64; 4]; cells], vec![[0f64; 2]; cells]);
        let mut nf = if with_rate { vec![0f64; cells] } else { Vec::new() };
        for (i, p) in points.iter().enumerate() {
            let (r, g, b) = wu.bin(i);
            let (w, x, y, z) = (p.wd(), p.v[1] as f64, p.v[2] as f64, p.v[3] as f64);
            let i = wu.gx(r, g, b);
            m4[i] = add4(m4[i], [w, w * x, w * y, w * z]);
            m2[i] = add2(m2[i], [w * (x * x + y * y + z * z), w * lum(x, y, z).powi(2)]);
            if with_rate { nf[i] += p.nf as f64; }
        }
        for r in 1..n[0] {
            let (mut area4, mut area2) = (vec![[0f64; 4]; n[2]], vec![[0f64; 2]; n[2]]);
            for g in 1..n[1] {
                let (mut line4, mut line2) = ([0f64; 4], [0f64; 2]);
                for b in 1..n[2] {
                    let (i, up) = (wu.gx(r, g, b), wu.gx(r - 1, g, b));
                    line4 = add4(line4, m4[i]); area4[b] = add4(area4[b], line4); m4[i] = add4(m4[up], area4[b]);
                    line2 = add2(line2, m2[i]); area2[b] = add2(area2[b], line2); m2[i] = add2(m2[up], area2[b]);
                }
            }
        }
        if with_rate {
            for r in 1..n[0] {
                let mut area = vec![0f64; n[2]];
                for g in 1..n[1] {
                    let mut line = 0f64;
                    for b in 1..n[2] { line += nf[wu.gx(r, g, b)]; area[b] += line; nf[wu.gx(r, g, b)] = nf[wu.gx(r - 1, g, b)] + area[b]; }
                }
            }
            wu.nf = Some(nf);
        }
        wu.m4 = m4; wu.m2 = m2;
        wu
    }
    /// Non-flat samples in a cube (rate-distortion mode only).
    fn vol_nf(&self, c: &Cube) -> f64 {
        let (l, h) = (c.lo, c.hi); let m = self.nf.as_ref().expect("rate table");
        m[self.gx(h[0], h[1], h[2])] + m[self.gx(h[0], l[1], l[2])] + m[self.gx(l[0], h[1], l[2])] + m[self.gx(l[0], l[1], h[2])]
            - m[self.gx(h[0], h[1], l[2])] - m[self.gx(h[0], l[1], h[2])] - m[self.gx(l[0], h[1], h[2])] - m[self.gx(l[0], l[1], l[2])]
    }
    /// The first four moments of a cube (weight and the three sums): what the cut search compares.
    fn vol4(&self, c: &Cube) -> M4 {
        let (l, h, m) = (c.lo, c.hi, &self.m4);
        let pos = add4(add4(m[self.gx(h[0], h[1], h[2])], m[self.gx(h[0], l[1], l[2])]), add4(m[self.gx(l[0], h[1], l[2])], m[self.gx(l[0], l[1], h[2])]));
        let neg = add4(add4(m[self.gx(h[0], h[1], l[2])], m[self.gx(h[0], l[1], h[2])]), add4(m[self.gx(l[0], h[1], h[2])], m[self.gx(l[0], l[1], l[2])]));
        sub4(pos, neg)
    }
    /// All six moments of a cube (for its variances).
    fn vol(&self, c: &Cube) -> M {
        let (l, h, m) = (c.lo, c.hi, &self.m2);
        let pos = add2(add2(m[self.gx(h[0], h[1], h[2])], m[self.gx(h[0], l[1], l[2])]), add2(m[self.gx(l[0], h[1], l[2])], m[self.gx(l[0], l[1], h[2])]));
        let neg = add2(add2(m[self.gx(h[0], h[1], l[2])], m[self.gx(h[0], l[1], h[2])]), add2(m[self.gx(l[0], h[1], h[2])], m[self.gx(l[0], l[1], l[2])]));
        let (a, b) = (self.vol4(c), sub2(pos, neg));
        [a[0], a[1], a[2], a[3], b[0], b[1]]
    }
    /// Best axis-aligned cut: the one that maximises the sum of q2(mean) * weight of the halves (= minimises variance).
    fn cut(&self, c: &Cube) -> Option<(Cube, Cube)> {
        let whole = self.vol4(c);
        let mut best: Option<(f64, usize, usize)> = None;
        for axis in 0..3 {
            for i in c.lo[axis] + 1..c.hi[axis] {
                let mut lower = *c;
                lower.hi[axis] = i;
                let (a, b) = { let a = self.vol4(&lower); (a, sub4(whole, a)) };
                if a[0] <= 0.0 || b[0] <= 0.0 { continue; }
                let score = q2(a[1], a[2], a[3]) / a[0] + q2(b[1], b[2], b[3]) / b[0];
                if best.map_or(true, |(s, ..)| score > s) { best = Some((score, axis, i)); }
            }
        }
        best.map(|(_, axis, i)| {
            let (mut a, mut b) = (*c, *c);
            a.hi[axis] = i; b.lo[axis] = i;
            (a, b)
        })
    }
}

enum Kind { Cube(Cube), List(usize, usize) }
/// A box of the divisive step: its remaining error `var` counts towards the stop test whether or not the box can
/// still be cut (`splittable`: false once a cut was tried and found impossible, a single Wu cell or one list value).
/// `refvar` / `lumvar` are the reference and luminance parts (var = refvar + LUMA_K * lumvar), `neutral` whether the
/// box counts in the luminance stop test (P21), `w` its weight.
struct Bx { kind: Kind, mean: [f64; 4], var: f64, refvar: f64, lumvar: f64, w: f64, neutral: bool, splittable: bool, trial: Option<Trial> }
/// The best cut of a box, found when the box is made (P28): its error reduction `dd` (design metric, weighted)
/// and the bits it adds `dr`. The cut itself is recomputed when the box is split (`cut` / `split_list` are
/// deterministic), so only the two numbers are kept.
#[derive(Clone, Copy)]
struct Trial { dd: f64, dr: f64 }
fn design_var(s: M) -> f64 { let (r, l) = variances(s); r + luma_k() as f64 * l }

/// Squared scale of the alpha axis in translucent-box statistics: over a white background `diff` charges a pure
/// alpha change dA^2 * (wr^2 + wg^2 + wb^2) = 2.25 dA^2.
const A2: [f64; 4] = [2.25, 1.0, 1.0, 1.0];

/// Weighted statistics of a list of translucent points: (w, sum v, sum of A2-scaled |v|^2, sum lum^2, non-flat).
fn list_stats<'a>(pts: impl Iterator<Item = &'a Point>) -> (f64, [f64; 4], f64, f64, f64) {
    let (mut w, mut m1, mut m2, mut ml, mut nf) = (0f64, [0f64; 4], 0f64, 0f64, 0f64);
    for p in pts {
        let pw = p.wd();
        w += pw; nf += p.nf as f64;
        for d in 0..4 { m1[d] += pw * p.v[d] as f64; }
        let (x, y, z) = (p.v[1] as f64, p.v[2] as f64, p.v[3] as f64);
        m2 += pw * (A2[0] * (p.v[0] as f64).powi(2) + x * x + y * y + z * z);
        ml += pw * lum(x, y, z).powi(2);
    }
    (w, m1, m2, ml, nf)
}
fn list_vars(w: f64, m1: [f64; 4], m2: f64, ml: f64) -> (f64, f64) {
    let refvar = (m2 - (A2[0] * m1[0] * m1[0] + m1[1] * m1[1] + m1[2] * m1[2] + m1[3] * m1[3]) / w.max(1e-30)).max(0.0);
    let lumvar = (ml - lum(m1[1], m1[2], m1[3]).powi(2) / w.max(1e-30)).max(0.0);
    (refvar, lumvar)
}
/// The axis of largest spread of a list and the threshold (its mean): `split_list` partitions on it.
fn list_axis(pts: &[Point], s: usize, e: usize, mean: &[f64; 4]) -> (usize, f32) {
    let mut spread = [0f64; 4];
    for p in &pts[s..e] { for d in 0..4 { spread[d] += A2[d] * p.wd() * (p.v[d] as f64 - mean[d]).powi(2); } }
    let axis = (0..4).max_by(|&a, &b| spread[a].partial_cmp(&spread[b]).unwrap()).unwrap();
    (axis, mean[axis] as f32)
}

/// `trial`: whether to evaluate the trial split (P28), which only the rate-distortion rule (`SHOTQ_LAMBDA`, off by
/// default) reads; it costs three more passes over the points (P44: skipped when off).
fn list_box(pts: &[Point], s: usize, e: usize, trial: bool) -> Bx {
    let (w, m1, m2, ml, nf) = list_stats(pts[s..e].iter());
    let mean = m1.map(|x| x / w.max(1e-30));
    let (refvar, lumvar) = list_vars(w, m1, m2, ml);
    let var = refvar + luma_k() as f64 * lumvar;
    // the trial split (P28): the two sides of the mean on the axis of largest spread, without moving any point
    let trial = if trial {
        let (axis, t) = list_axis(pts, s, e, &mean);
        let (wa, ma, m2a, mla, nfa) = list_stats(pts[s..e].iter().filter(|p| p.v[axis] <= t));
        let (wb, mb, m2b, mlb, _) = list_stats(pts[s..e].iter().filter(|p| p.v[axis] > t));
        (wa > 0.0 && wb > 0.0).then(|| {
            let (ra, la) = list_vars(wa, ma, m2a, mla); let (rb, lb) = list_vars(wb, mb, m2b, mlb);
            Trial { dd: var - (ra + luma_k() as f64 * la) - (rb + luma_k() as f64 * lb), dr: split_bits(nf, nfa) }
        })
    } else { None };
    Bx { kind: Kind::List(s, e), mean, var, refvar, lumvar, w, neutral: false, splittable: true, trial }
}

fn split_list(pts: &mut [Point], s: usize, e: usize, mean: &[f64; 4]) -> Option<usize> {
    let (axis, t) = list_axis(pts, s, e, mean);
    let (mut i, mut j) = (s, e);
    while i < j { if pts[i].v[axis] <= t { i += 1; } else { j -= 1; pts.swap(i, j); } }
    (i > s && i < e).then_some(i)
}

/// The stop test of the divisive step divides the context-weighted error by the *plain* sample total (0.13.0): the
/// error of smooth gradients counts CTX_SMOOTH times against the same target, which tightens the target wherever
/// gradients are (Chat B's original form). Measured against dividing by the weighted total (which only moves the
/// allocation, 0.12.0) at equal bytes on the real screenshots: false contours -22%, neutral luma +0.1 dB, RGB
/// -0.2 dB; on pure grey ramps the banding step halves (9.8 -> 5.1 levels) for twice the bytes. `SHOTQ_CTX_TIGHT=0`
/// restores the 0.12.0 rule. HANDOFF P24.
const CTX_TIGHT: bool = true;
fn ctx_tight() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| std::env::var("SHOTQ_CTX_TIGHT").map_or(CTX_TIGHT, |s| s != "0"))
}

/// Returns initial centres; sets `cluster` on every point.
/// The banding bookkeeping of P27, built when the error target is first met (the boxes only get cut after that,
/// so it is never out of date): which box each pair endpoint is in, the pairs touching each box, which pairs
/// show a visible step (their boxes' mean luma differ by >= `t`), each box's share of the visible pair samples.
struct BandState { owner: Vec<u16>, members: Vec<Vec<u32>>, plist: Vec<Vec<u32>>, visible: Vec<bool>, luma: Vec<f64>, band_of: Vec<f64>, vis_total: f64, t: f64, ends: Vec<u32>, pairs: Vec<(u32, u32, u32)>, pair_total: f64 }
impl BandState {
    /// `pairs` in point indices (as `pairs_to_points` returns them), `pair_total` their count before any was
    /// dropped. Only the points that take part in a pair are tracked (`ends`, in point order) and the pairs are
    /// re-indexed to them; since P44 that is done here, on the first need, so an image that splits to 256
    /// colours before meeting the target never pays for it.
    fn build(boxes: &[Bx], wu: &Wu, pairs: &[(u32, u32, u32)], pair_total: f64, space: &ColorSpace, t: f64) -> Self {
        let mut ends: Vec<u32> = pairs.iter().flat_map(|p| [p.0, p.1]).collect(); ends.sort_unstable(); ends.dedup();
        let pairs: Vec<(u32, u32, u32)> = pairs.iter().map(|p| (ends.binary_search(&p.0).unwrap() as u32, ends.binary_search(&p.1).unwrap() as u32, p.2)).collect();
        let k = boxes.len();
        let mut tag = vec![0u16; wu.n[0] * wu.n[1] * wu.n[2]];
        for (b, bx) in boxes.iter().enumerate() {
            if let Kind::Cube(c) = bx.kind { for r in c.lo[0] + 1..=c.hi[0] { for g in c.lo[1] + 1..=c.hi[1] { for bl in c.lo[2] + 1..=c.hi[2] { tag[wu.gx(r, g, bl)] = b as u16; } } } }
        }
        let owner: Vec<u16> = ends.iter().map(|&pt| { let (r, g, b) = wu.bin(pt as usize); tag[wu.gx(r, g, b)] }).collect();
        let mut st = BandState { owner, members: vec![Vec::new(); k], plist: vec![Vec::new(); k], visible: vec![false; pairs.len()], luma: boxes.iter().map(|b| code_luma(&b.mean, space)).collect(), band_of: vec![0.0; k], vis_total: 0.0, t, ends, pairs: Vec::new(), pair_total };
        for (e, &o) in st.owner.iter().enumerate() { st.members[o as usize].push(e as u32); }
        for (pi, &(a, b, n)) in pairs.iter().enumerate() {
            let (oa, ob) = (st.owner[a as usize] as usize, st.owner[b as usize] as usize);
            st.plist[oa].push(pi as u32); if ob != oa { st.plist[ob].push(pi as u32); }
            if oa != ob && (st.luma[oa] - st.luma[ob]).abs() >= t { let n = n as f64; st.band_of[oa] += n; st.band_of[ob] += n; st.vis_total += n; st.visible[pi] = true; }
        }
        st.pairs = pairs;
        st
    }
    /// Box `i` was cut; its second half is the new box `j` (the last one), a cube. Endpoints and pairs follow.
    fn cut(&mut self, i: usize, j: usize, cube_j: &Cube, boxes: &[Bx], wu: &Wu, space: &ColorSpace) {
        let inside = |c: &Cube, b: (usize, usize, usize)| b.0 > c.lo[0] && b.0 <= c.hi[0] && b.1 > c.lo[1] && b.1 <= c.hi[1] && b.2 > c.lo[2] && b.2 <= c.hi[2];
        // 1. the pairs touching box i lose their visibility (their boxes are about to change)
        let old_pairs = std::mem::take(&mut self.plist[i]);
        for &pi in &old_pairs {
            if self.visible[pi as usize] {
                let (a, b, n) = self.pairs[pi as usize]; let n = n as f64;
                self.band_of[self.owner[a as usize] as usize] -= n; self.band_of[self.owner[b as usize] as usize] -= n; self.vis_total -= n; self.visible[pi as usize] = false;
            }
        }
        // 2. the endpoints of box i are shared out between i and j
        let old_members = std::mem::take(&mut self.members[i]);
        while self.members.len() <= j { self.members.push(Vec::new()); self.plist.push(Vec::new()); self.band_of.push(0.0); self.luma.push(0.0); }
        for &pt in &old_members { if inside(cube_j, wu.bin(self.ends[pt as usize] as usize)) { self.owner[pt as usize] = j as u16; self.members[j].push(pt); } else { self.members[i].push(pt); } }
        self.luma[i] = code_luma(&boxes[i].mean, space); self.luma[j] = code_luma(&boxes[j].mean, space);
        // 3. the pairs are re-evaluated against the new means and re-listed
        for &pi in &old_pairs {
            let (a, b, n) = self.pairs[pi as usize];
            let (oa, ob) = (self.owner[a as usize] as usize, self.owner[b as usize] as usize);
            if oa != ob && (self.luma[oa] - self.luma[ob]).abs() >= self.t { let n = n as f64; self.band_of[oa] += n; self.band_of[ob] += n; self.vis_total += n; self.visible[pi as usize] = true; }
            if oa == i || ob == i { self.plist[i].push(pi); }
            if oa == j || ob == j { self.plist[j].push(pi); }
        }
    }
}

/// `extra_w`: weight of points served exactly outside the boxes (pre-pins), which count in the stop test's
/// denominator with no error; `k_max`: the boxes left for the split.
fn divide(opaque: &mut [Point], trans: &mut [Point], a_opaque: f32, target_mse: f64, space: &ColorSpace, mut pairs: Pairs, extra_w: f64, extra_err: f64, k_max: usize) -> Vec<[f32; 4]> {
    let total_w: f64 = opaque.iter().chain(trans.iter()).map(|p| if ctx_tight() { p.w as f64 } else { p.wd() }).sum::<f64>() + extra_w;
    let lambda = lambda85() * if target_mse > 0.0 { target_mse / (quality_to_mse(85) * stop_scale()) } else { 0.0 }; // scales with (100 - q) / 15
    let wu = Wu::new(opaque, lambda > 0.0);
    let rho = rho();
    let mut boxes: Vec<Bx> = Vec::with_capacity(k_max);
    let cube_box = |wu: &Wu, c: Cube| -> Bx {
        let s = wu.vol(&c);
        let mean = [a_opaque as f64, s[1] / s[0].max(1e-30), s[2] / s[0].max(1e-30), s[3] / s[0].max(1e-30)];
        let (refvar, lumvar) = variances(s);
        let var = refvar + luma_k() as f64 * lumvar;
        // the best cut and what it is worth, found once per box (P28): its halves' error and non-flat samples
        let trial = if lambda > 0.0 {
            wu.cut(&c).map(|(a, b)| { let (sa, sb) = (wu.vol(&a), wu.vol(&b)); Trial { dd: var - design_var(sa) - design_var(sb), dr: split_bits(wu.vol_nf(&c), wu.vol_nf(&a)) } })
        } else { None };
        // `neutral` only matters to the luminance stop test (`SHOTQ_RHO`, off by default); three `decode`s per
        // box otherwise (P44)
        Bx { kind: Kind::Cube(c), neutral: rho > 0.0 && is_neutral(&mean, space), mean, var, refvar, lumvar, w: s[0], splittable: true, trial }
    };
    if !opaque.is_empty() { boxes.push(cube_box(&wu, Cube { lo: [0; 3], hi: [wu.n[0] - 1, wu.n[1] - 1, wu.n[2] - 1] })); }
    if !trans.is_empty() { boxes.push(list_box(trans, 0, trans.len(), lambda > 0.0)); }
    // Banding rule (P27): the bookkeeping (`BandState`, with its endpoint list and re-indexed pairs, and since P45
    // the mapping of the recorded colour pairs to point pairs) is built when the error target is first met; an
    // image that splits to 256 colours first never builds it. A non-empty record whose pairs all fold into single
    // points gives an empty `BandState` that stops at once, the same decision as no record.
    let banding = band_max() > 0.0 && !pairs.is_empty() && !opaque.is_empty();
    let (band, band_t) = (band_max(), band_thr());
    let mut band_state: Option<BandState> = None;
    let mut band_cuts = 0usize;
    while boxes.len() < k_max {
        // The stop test sums the error of every box, including those that cannot be cut: "not splittable on Wu's
        // grid" is not "no error" (a single 6-bit cell holding an exact colour and the rest of its cell keeps
        // 5-13% of the --quality 85 budget on some screenshots; the pin and snap steps deal with it later).
        // With RHO > 0 (P21) two conditions must hold: the reference error meets the target, and the luminance error
        // of the neutral boxes, over their own weight, meets target / RHO. While the first fails the box with the
        // largest design error is cut; when only the second fails, the neutral box with the largest luminance error.
        let (err_design, err_ref, err_lum, w_neutral) = boxes.iter().fold((extra_err, extra_err, 0.0, 0.0), |a, b| (a.0 + b.var, a.1 + b.refvar, a.2 + if b.neutral { b.lumvar } else { 0.0 }, a.3 + if b.neutral { b.w } else { 0.0 }));
        let pick = if lambda > 0.0 {
            // rate-distortion (P28): the cut worth most after paying for its bits; none worth it -> done
            boxes.iter().enumerate().filter(|(_, b)| b.splittable && b.trial.is_some()).map(|(i, b)| (i, b.trial.unwrap()))
                .map(|(i, t)| (i, t.dd - lambda * t.dr)).filter(|&(_, g)| g > 0.0).max_by(|a, b| a.1.partial_cmp(&b.1).unwrap().then(b.0.cmp(&a.0)))
        } else {
            let ref_ok = if rho > 0.0 { err_ref / total_w <= target_mse } else { err_design / total_w <= target_mse };
            let lum_ok = rho <= 0.0 || w_neutral <= 0.0 || err_lum / w_neutral <= target_mse / rho;
            if ref_ok && lum_ok {
                // good enough for --quality max: stop early, fewer colours; unless the banding rule (P27) still
                // sees too many visible steps, in which case the box taking part in most of them is cut
                if !banding { break; }
                let st = band_state.get_or_insert_with(|| { let (pp, total) = pairs.resolve(&*opaque); BandState::build(&boxes, &wu, pp, total, space, band_t) });
                if st.vis_total <= band * st.pair_total { break; }
                let pick = boxes.iter().enumerate().filter(|(k, b)| b.splittable && matches!(b.kind, Kind::Cube(_)) && st.band_of[*k] > 0.0).map(|(k, _)| (k, st.band_of[k]))
                    .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap().then(b.0.cmp(&a.0)));
                if pick.is_some() { band_cuts += 1; }
                pick
            } else if !ref_ok { boxes.iter().enumerate().filter(|(_, b)| b.splittable && b.var > 0.0).map(|(i, b)| (i, b.var)).max_by(|a, b| a.1.partial_cmp(&b.1).unwrap()) }
            else { boxes.iter().enumerate().filter(|(_, b)| b.splittable && b.neutral && b.lumvar > 0.0).map(|(i, b)| (i, b.lumvar)).max_by(|a, b| a.1.partial_cmp(&b.1).unwrap()) }
        };
        let Some((i, _)) = pick else { break };
        let halves = match boxes[i].kind {
            Kind::Cube(c) => wu.cut(&c).map(|(a, b)| (cube_box(&wu, a), cube_box(&wu, b))),
            Kind::List(s, e) => { let mean = boxes[i].mean; split_list(trans, s, e, &mean).map(|m| (list_box(trans, s, m, lambda > 0.0), list_box(trans, m, e, lambda > 0.0))) }
        };
        match halves {
            Some((a, b)) => {
                boxes[i] = a; boxes.push(b);
                if let Some(st) = band_state.as_mut() {
                    let j = boxes.len() - 1;
                    if let Kind::Cube(cb) = boxes[j].kind { st.cut(i, j, &cb, &boxes, &wu, space); }
                }
            }
            None => boxes[i].splittable = false, // cannot be split further; its error stays in the total
        }
    }
    if banding && std::env::var_os("SHOTQ_DEBUG").is_some() {
        match &band_state {
            Some(s) => eprintln!("  quant: banding {:.2}% of {:.0} pair samples visible (>= {band_t} levels) after {band_cuts} banding cuts, {} point pairs", 100.0 * s.vis_total / s.pair_total.max(1e-30), s.pair_total, s.pairs.len()),
            None => eprintln!("  quant: banding not evaluated ({k_max} boxes before the target; {} colour pairs recorded, never mapped)", pairs.len()),
        }
    }
    if std::env::var_os("SHOTQ_DEBUG").is_some() {
        let (err, stuck) = boxes.iter().fold((0.0, 0), |a, b| (a.0 + b.var, a.1 + !b.splittable as usize));
        eprintln!("  quant: divide stopped at {} boxes ({} unsplittable), design error {:.3e} vs target {:.3e}", boxes.len(), stuck, err / total_w.max(1e-30), target_mse);
    }
    let mut tag = vec![0u16; wu.n[0] * wu.n[1] * wu.n[2]];
    for (k, b) in boxes.iter().enumerate() {
        match b.kind {
            Kind::Cube(c) => for r in c.lo[0] + 1..=c.hi[0] { for g in c.lo[1] + 1..=c.hi[1] { for bl in c.lo[2] + 1..=c.hi[2] { tag[wu.gx(r, g, bl)] = k as u16; } } },
            Kind::List(s, e) => for p in &mut trans[s..e] { p.cluster = k as u16; },
        }
    }
    for (i, p) in opaque.iter_mut().enumerate() {
        let (r, g, b) = wu.bin(i);
        p.cluster = tag[wu.gx(r, g, b)];
    }
    boxes.iter().map(|b| b.mean.map(|x| x as f32)).collect()
}

// ---------------------------------------------------------------- 3. weighted k-means with exact pruning

const NB: usize = 64;

/// A x for A = I + alpha l l^T, the symmetric square root of I + l l^T (alpha = (sqrt(1 + |l|^2) - 1) / |l|^2):
/// |A (p - q)|^2 = |p - q|^2 + (l . (p - q))^2, which is `diff_with(p, q, l)` on opaque colours.
#[inline(always)]
fn whiten(x: [f32; 3], l: [f32; 3]) -> [f32; 3] {
    let n2 = l[0] * l[0] + l[1] * l[1] + l[2] * l[2];
    if n2 <= 0.0 { return x; }
    let t = ((1.0 + n2).sqrt() - 1.0) / n2 * (l[0] * x[0] + l[1] * x[1] + l[2] * x[2]);
    [x[0] + t * l[0], x[1] + t * l[1], x[2] + t * l[2]]
}

/// For each centre, its NB nearest other centres sorted by the squared distance of the X,Y,Z part in the whitened
/// coordinates of the metric `l` (P38). `diff_with` is exactly that distance on opaque colours (and at least it on
/// translucent ones, whose terms take a max), so the triangle-inequality bound in `search` is tight instead of
/// the plain X,Y,Z bound that ignored the luminance term: fewer candidates, the same exact answer.
fn neighbours(centres: &[[f32; 4]], l: [f32; 3]) -> Vec<Vec<(f32, u16)>> {
    let w: Vec<[f32; 3]> = centres.iter().map(|c| whiten([c[1], c[2], c[3]], l)).collect();
    w.par_iter().enumerate().map(|(i, c)| {
        let mut v: Vec<(f32, u16)> = w.iter().enumerate().filter(|&(j, _)| j != i)
            .map(|(j, o)| ((c[0] - o[0]).powi(2) + (c[1] - o[1]).powi(2) + (c[2] - o[2]).powi(2), j as u16)).collect();
        if v.len() > NB { v.select_nth_unstable_by(NB - 1, |a, b| a.0.partial_cmp(&b.0).unwrap()); v.truncate(NB); }
        v.sort_unstable_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        v
    }).collect()
}

/// Exact nearest centre, starting from a guess. Triangle inequality in the whitened X,Y,Z coordinates (equal to
/// `diff` on opaque colours, a lower bound on translucent ones): a centre c' can only beat the current best if
/// |own - c'| < sqrt(d(p, own)) + sqrt(best). The neighbour list is sorted by that distance, so the scan stops at
/// the first failure (with a relative margin of 1e-5 against f32 rounding, which only admits extra candidates).
/// Ties go to the lower index, so the answer does not depend on the starting guess.
#[inline(always)]
fn search(centres: &[[f32; 4]], nb: &[Vec<(f32, u16)>], v: &[f32; 4], own: usize, l: [f32; 3]) -> (usize, f32) {
    let own_d = diff_with(v, &centres[own], l);
    let (mut best, mut ub) = (own, own_d);
    let root = own_d.sqrt();
    let mut limit = 4.0 * own_d;
    let mut exhausted = true;
    for &(d2, j) in &nb[own] {
        if d2 > limit * (1.0 + 1e-5) { exhausted = false; break; }
        let d = diff_with(v, &centres[j as usize], l);
        if d < ub || (d == ub && (j as usize) < best) { ub = d; best = j as usize; limit = (root + d.sqrt()).powi(2); }
    }
    if exhausted && centres.len() > NB + 1 { // rare: the bound never cut the short list, so check everything
        for (j, c) in centres.iter().enumerate() {
            let d = diff_with(v, c, l);
            if d < ub || (d == ub && j < best) { ub = d; best = j; }
        }
    }
    (best, ub)
}

/// Nearest-palette-entry search for the remapper: the same exact pruned search. The pruning only pays off when the
/// starting guess is close, and the previous pixel's entry is a bad guess for a colour unlike its neighbour (every
/// pixel of a translucent gradient's edge, every cell of a noisy picture): the scan then falls through all 64
/// neighbours and to the full 256. So a coarse 4-D grid over the input colour (3 bits per channel and of alpha,
/// 4096 cells) remembers the nearest entry of each cell's centre, filled on first use, and the search starts from
/// the better of the two guesses. The answer never depends on the guess (ties go to the lower index).
/// The search uses `remap_luma()` (P18): the plain difference by default, not the design metric.
pub struct Searcher { centres: Vec<[f32; 4]>, nb: Vec<Vec<(f32, u16)>>, seed: Vec<AtomicU16>, pub luma: [f32; 3], rmax: f32, all: Vec<Vec<(f32, u16)>>, planes: Vec<Vec<[f32; 5]>> }

impl Searcher {
    pub fn new(space: &ColorSpace, pal: &[Rgba]) -> Self {
        let centres: Vec<[f32; 4]> = pal.iter().map(|c| space.conv(c.r, c.g, c.b, c.a)).collect();
        // the largest colour cell in the metric is the brightest one (the curve is convex): its radius bounds every cell's
        let l = remap_luma();
        let ctr = space.conv(254, 254, 254, 255);
        let rmax = (0..8).map(|k| { let c = |b: usize| if k & b == 0 { 252u8 } else { 255 }; diff_with(&space.conv(c(1), c(2), c(4), 255), &ctr, l) }).fold(0f32, f32::max).sqrt();
        Searcher { nb: neighbours(&centres, l), centres, seed: (0..1 << 12).map(|_| AtomicU16::new(u16::MAX)).collect(), luma: l, rmax, all: Vec::new(), planes: Vec::new() }
    }
    /// The same metric without the search: no neighbour lists (255 x 256 distances) and no seed grid (P38). For
    /// callers that only measure `dist` (the edge sub-palette); `nearest` must not be called on it.
    pub fn dist_only(space: &ColorSpace, pal: &[Rgba]) -> Self {
        Searcher { nb: Vec::new(), centres: pal.iter().map(|c| space.conv(c.r, c.g, c.b, c.a)).collect(), seed: Vec::new(), luma: remap_luma(), rmax: 0.0, all: Vec::new(), planes: Vec::new() }
    }
    /// Does the remapper use the same difference as the palette design? If not, cell answers from the design
    /// must not be reused (`build_lut` in main.rs).
    pub fn same_metric_as_design(&self) -> bool { self.luma == luma() }
    /// The palette entry `i` in the colour space (what `nearest` measures against).
    #[inline(always)] pub fn centre(&self, i: usize) -> &[f32; 4] { &self.centres[i] }
    /// The remap metric between a converted pixel and entry `i`.
    #[inline(always)] pub fn dist(&self, v: &[f32; 4], i: usize) -> f32 { diff_with(v, &self.centres[i], self.luma) }
    /// The separating planes for the proofs (P43): for entry i and each of its neighbours j, d(v, c_j) - d(v, c_i)
    /// = w . v + kappa with w = 2 M (c_i - c_j), kappa = |c_j|^2_M - |c_i|^2_M (M = I + l l^T), plus the rounding
    /// allowance 1e-5 (|c_i|^2_M + |c_j|^2_M). Built once per remap (in parallel), read by `certify`.
    pub fn build_planes(&mut self) {
        let l = self.luma;
        let mn = |c: &[f32; 4]| { let t = l[0] * c[1] + l[1] * c[2] + l[2] * c[3]; c[1] * c[1] + c[2] * c[2] + c[3] * c[3] + t * t };
        let c = &self.centres;
        // every other entry, sorted by the whitened distance (the 64-entry list of the search would run out on cells
        // far from their entry, which then cost a scan of everything)
        let w: Vec<[f32; 3]> = c.iter().map(|c| whiten([c[1], c[2], c[3]], l)).collect();
        self.all = w.par_iter().enumerate().map(|(i, ci)| {
            let mut v: Vec<(f32, u16)> = w.iter().enumerate().filter(|&(j, _)| j != i).map(|(j, o)| ((ci[0] - o[0]).powi(2) + (ci[1] - o[1]).powi(2) + (ci[2] - o[2]).powi(2), j as u16)).collect();
            v.sort_unstable_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.cmp(&b.1)));
            v
        }).collect();
        self.planes = self.all.par_iter().enumerate().map(|(i, list)| list.iter().map(|&(_, j)| {
            let (ci, cj) = (&c[i], &c[j as usize]);
            let u = [ci[1] - cj[1], ci[2] - cj[2], ci[3] - cj[3]];
            let lu = l[0] * u[0] + l[1] * u[1] + l[2] * u[2];
            let (mi, mj) = (mn(ci), mn(cj));
            [2.0 * (u[0] + lu * l[0]), 2.0 * (u[1] + lu * l[1]), 2.0 * (u[2] + lu * l[2]), mj - mi, 1e-5 * (mi + mj)]
        }).collect()).collect();
    }
    /// The proof of a colour cell (P43, the proof table of main.rs): with `own` as the cell's answer, which other
    /// entries can beat it somewhere in the RGB box [lo, lo + 3] of opaque colours (one 4 x 4 x 4 cell). On opaque
    /// colours the difference is the squared M-norm, so d(v, c_j) - d(v, c_own) is affine in the stored vector v
    /// (`build_planes`), and the box is axis-aligned there (the curve is monotone per channel): the minimum over
    /// the box sits at a corner, sum_k min(w_k lo_k, w_k hi_k). Only entries within 2 (|c - c_own|_M + R) of c_own
    /// can win anywhere in the box (triangle inequality; c the box's centre, R its radius: half the diagonal, whose
    /// M-norm is largest at the all-positive corner), the neighbour list is sorted by that distance, so the scan
    /// stops early; a cell whose ball stays inside own's Voronoi region needs no scan at all; when the list runs
    /// out every entry is checked. A translucent entry's difference to an opaque colour is at least its M-norm, so
    /// the test is sound for it; a translucent `own` is refused. Rounding errs towards more candidates. Returns how
    /// many candidates went into `out`, None when they do not fit or `own` is translucent (the cell is then resolved
    /// per pixel).
    pub fn certify(&self, space: &ColorSpace, lo: [u8; 3], own: usize, out: &mut [u16; 4]) -> Option<usize> { self.certify_stats(space, lo, own, out).0 }
    /// `certify` plus (proved by the quick test, neighbours scanned, every entry scanned) for the diagnostics.
    pub fn certify_stats(&self, space: &ColorSpace, lo: [u8; 3], own: usize, out: &mut [u16; 4]) -> (Option<usize>, bool, usize, bool) {
        let l = self.luma;
        let co = &self.centres[own];
        if co[0] < 1.0 { return (None, false, 0, false); }
        let (vl, vh) = (space.conv(lo[0], lo[1], lo[2], 255), space.conv(lo[0] | 3, lo[1] | 3, lo[2] | 3, 255));
        let mn3 = |x: [f32; 3]| { let t = l[0] * x[0] + l[1] * x[1] + l[2] * x[2]; x[0] * x[0] + x[1] * x[1] + x[2] * x[2] + t * t };
        let r = mn3([(vh[1] - vl[1]) * 0.5, (vh[2] - vl[2]) * 0.5, (vh[3] - vl[3]) * 0.5]).sqrt();
        let cb = [(vl[1] + vh[1]) * 0.5, (vl[2] + vh[2]) * 0.5, (vl[3] + vh[3]) * 0.5];
        let dc = mn3([cb[0] - co[1], cb[1] - co[2], cb[2] - co[3]]).sqrt();
        let list = &self.all[own];
        if let Some(&(d2, _)) = list.first() { if 2.0 * (dc + r) < d2.sqrt() * (1.0 - 1e-5) { return (Some(0), true, 0, false); } }
        let dmax = 2.0 * (dc + r);
        let dmax2 = dmax * dmax * (1.0 + 1e-4);
        let mc = mn3(cb) * 1e-5;
        let mut n = 0usize;
        let mut scanned = 0usize;
        let planes = &self.planes[own];
        for (k, &(d2, j)) in list.iter().enumerate() {
            if d2 > dmax2 { break; }
            scanned += 1;
            let w = &planes[k];
            let m = w[3] + (w[0] * vl[1]).min(w[0] * vh[1]) + (w[1] * vl[2]).min(w[1] * vh[2]) + (w[2] * vl[3]).min(w[2] * vh[3]);
            if m <= w[4] + mc { if n == out.len() { return (None, false, scanned, false); } out[n] = j; n += 1; }
        }
        (Some(n), false, scanned, scanned == list.len())
    }
    /// `v` must be `space.conv` of `rgba`.
    #[inline(always)]
    pub fn nearest(&self, space: &ColorSpace, rgba: [u8; 4], v: [f32; 4], guess: usize) -> u16 {
        debug_assert!(!self.seed.is_empty(), "nearest on a dist_only Searcher");
        let cell = (rgba[0] as usize >> 5) << 9 | (rgba[1] as usize >> 5) << 6 | (rgba[2] as usize >> 5) << 3 | rgba[3] as usize >> 5;
        let mut s = self.seed[cell].load(Ordering::Relaxed) as usize;
        if s == u16::MAX as usize {
            let mid = |x: u8| x & !31 | 16;
            let c = space.conv(mid(rgba[0]), mid(rgba[1]), mid(rgba[2]), if rgba[3] == 255 { 255 } else { mid(rgba[3]) });
            s = self.centres.iter().enumerate().fold((0usize, f32::MAX), |b, (j, o)| { let d = diff_with(&c, o, self.luma); if d < b.1 { (j, d) } else { b } }).0;
            self.seed[cell].store(s as u16, Ordering::Relaxed);
        }
        let g = guess.min(self.centres.len() - 1);
        let own = if diff_with(&v, &self.centres[s], self.luma) < diff_with(&v, &self.centres[g], self.luma) { s } else { g };
        search(&self.centres, &self.nb, &v, own, self.luma).0 as u16
    }
}

/// One assignment pass: every point gets its nearest centre and its error. With SUMS the per-centre
/// [weight, sum of v] for the Lloyd update is accumulated and returned; without, nothing is accumulated (P38: only
/// the Lloyd step reads the sums, the other callers need the assignment alone). The search itself is the same.
fn assign<const SUMS: bool>(points: &mut [Point], centres: &[[f32; 4]]) -> Vec<[f64; 5]> {
    let nb = neighbours(centres, luma());
    let k = centres.len();
    if !SUMS {
        points.par_chunks_mut(4096).for_each(|chunk| {
            for p in chunk {
                let (best, ub) = search(centres, &nb, &p.v, p.cluster as usize, luma());
                p.cluster = best as u16;
                p.d = ub;
            }
        });
        return Vec::new();
    }
    points.par_chunks_mut(4096).map(|chunk| {
        let mut sums = vec![[0f64; 5]; k];
        for p in chunk {
            let (best, ub) = search(centres, &nb, &p.v, p.cluster as usize, luma());
            p.cluster = best as u16;
            p.d = ub;
            let (w, s) = (p.wd(), &mut sums[best]);
            s[0] += w;
            for d in 0..4 { s[d + 1] += w * p.v[d] as f64; }
        }
        sums
    }).reduce(|| vec![[0f64; 5]; k], |mut a, b| {
        for (x, y) in a.iter_mut().zip(&b) { for d in 0..5 { x[d] += y[d]; } }
        a
    })
}

// ---------------------------------------------------------------- 3b. exchange at 256 colours (P23)

/// At most this many merge-and-split exchanges per image.
const EXCHANGE_MAX: usize = 32;

/// When all 256 entries are in use nothing can be rescued or pinned, and the divisive step's axis-aligned cuts
/// leave clusters that are cheap to merge (two entries a few levels apart) next to clusters that would gain a lot
/// from a split (a gradient held by one entry). While the largest split gain exceeds the smallest merge cost, the
/// cheapest pair is merged (Ward's cost W_i W_j / (W_i + W_j) diff(c_i, c_j): the exact increase of the weighted
/// squared error for the fixed assignment) and the freed entry splits the best cluster along its principal axis at
/// the mean (the exact decrease, the same formula on the two halves). Translucent clusters and clusters a flat
/// colour dominates (the snap step keeps that colour) are never merged. Deterministic: the point order is fixed and
/// ties go to the lowest index. Returns the number of exchanges; the caller runs a Lloyd pass afterwards.
fn exchange(points: &mut [Point], centres: &mut [[f32; 4]], protected: &[bool]) -> usize {
    let k = centres.len();
    let mut members: Vec<Vec<u32>> = vec![Vec::new(); k];
    for (i, p) in points.iter().enumerate() { members[p.cluster as usize].push(i as u32); }
    let mut opaque: Vec<bool> = (0..k).map(|c| members[c].iter().all(|&i| points[i as usize].cell != u32::MAX)).collect();
    let mut protected = protected.to_vec();
    fn wmean(pts: &[Point], m: &[u32]) -> (f64, [f32; 4]) {
        let (mut w, mut s) = (0f64, [0f64; 4]);
        for &i in m { let p = &pts[i as usize]; w += p.wd(); for d in 0..4 { s[d] += p.wd() * p.v[d] as f64; } }
        (w, s.map(|x| (x / w.max(1e-30)) as f32))
    }
    /// The split of a cluster along its principal axis at the mean: (design gain, reference gain, first half,
    /// second half). With SHOTQ_EX_AXIS=1 (P41, experiment) the axis is the principal axis in the metric's whitened
    /// coordinates (`diff` on opaque colours is the squared distance there, so the axis and the gain agree) and the
    /// cut is the better, by the real gain, of the mean and the exact 1-D 2-means threshold along the axis
    /// (Gronlund et al. 2017: sorted projections and prefix sums).
    // `mean`: the cluster's weighted mean as `wmean` gives it (P45: the callers have just computed it; the pass
    // that recomputed it here is gone)
    fn split_of(pts: &[Point], m: &[u32], mean: [f32; 4]) -> (f64, f64, Vec<u32>, Vec<u32>) {
        if m.len() < 2 { return (0.0, 0.0, Vec::new(), Vec::new()); }
        let l = luma(); let n2 = (l[0] * l[0] + l[1] * l[1] + l[2] * l[2]) as f64;
        let alpha = if ex_axis() && n2 > 0.0 { ((1.0 + n2).sqrt() - 1.0) / n2 } else { 0.0 };
        let wh = |d: [f64; 3]| -> [f64; 3] {
            if alpha == 0.0 { return d; }
            let t = alpha * (l[0] as f64 * d[0] + l[1] as f64 * d[1] + l[2] as f64 * d[2]);
            [d[0] + t * l[0] as f64, d[1] + t * l[1] as f64, d[2] + t * l[2] as f64]
        };
        let delta = |p: &Point| wh([(p.v[1] - mean[1]) as f64, (p.v[2] - mean[2]) as f64, (p.v[3] - mean[3]) as f64]);
        let mut cov = [[0f64; 3]; 3];
        for &i in m {
            let p = &pts[i as usize];
            let d = delta(p);
            for a in 0..3 { for b in 0..3 { cov[a][b] += p.wd() * d[a] * d[b]; } }
        }
        let mut u = [0.577_350_3f64; 3];
        for _ in 0..8 {
            let v = [0, 1, 2].map(|a| cov[a][0] * u[0] + cov[a][1] * u[1] + cov[a][2] * u[2]);
            let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            if n <= 0.0 { return (0.0, 0.0, Vec::new(), Vec::new()); }
            u = v.map(|x| x / n);
        }
        let proj = |p: &Point| { let d = delta(p); d[0] * u[0] + d[1] * u[1] + d[2] * u[2] };
        let gain_of = |a: &[u32], b: &[u32]| { let ((wa, ca), (wb, cb)) = (wmean(pts, a), wmean(pts, b)); let f = wa * wb / (wa + wb); (f * diff(&ca, &cb) as f64, f * diff_report(&ca, &cb) as f64) };
        let (a, b): (Vec<u32>, Vec<u32>) = m.iter().partition(|&&i| proj(&pts[i as usize]) <= 0.0);
        if a.is_empty() || b.is_empty() { return (0.0, 0.0, Vec::new(), Vec::new()); }
        let (g1, r1) = gain_of(&a, &b);
        if alpha == 0.0 { return (g1, r1, a, b); }
        // the exact 1-D 2-means cut along the axis: maximise S1^2/W1 + S2^2/W2 over the sorted projections
        let mut order: Vec<(f64, u32)> = m.iter().map(|&i| (proj(&pts[i as usize]), i)).collect();
        order.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap().then(x.1.cmp(&y.1)));
        let (tw, ts) = order.iter().fold((0f64, 0f64), |(w, s), &(t, i)| { let wd = pts[i as usize].wd(); (w + wd, s + wd * t) });
        let (mut cw, mut cs, mut best) = (0f64, 0f64, (f64::MIN, 0usize));
        for (k, &(t, i)) in order[..order.len() - 1].iter().enumerate() {
            let wd = pts[i as usize].wd(); cw += wd; cs += wd * t;
            let (rw, rs) = (tw - cw, ts - cs);
            if cw > 0.0 && rw > 0.0 { let sc = cs * cs / cw + rs * rs / rw; if sc > best.0 { best = (sc, k + 1); } }
        }
        if best.1 == 0 { return (g1, r1, a, b); }
        let (a2, b2): (Vec<u32>, Vec<u32>) = (order[..best.1].iter().map(|x| x.1).collect(), order[best.1..].iter().map(|x| x.1).collect());
        let (g2, r2) = gain_of(&a2, &b2);
        if g2 > g1 { (g2, r2, a2, b2) } else { (g1, r1, a, b) }
    }
    // Per cluster: the weighted mean, and the split that is kept and reused by the guard and the split itself
    // (P38); it is recomputed only for the clusters an exchange changed, so the results are the ones the
    // recomputation would give. The clusters are independent, so this runs in parallel (P45): each writes its
    // own index only and no floating-point sum crosses clusters.
    let init: Vec<(f64, [f32; 4], (f64, f64, Vec<u32>, Vec<u32>))> = (0..k).into_par_iter().map(|c| {
        let (wc, mc) = wmean(&*points, &members[c]);
        (wc, mc, if opaque[c] { split_of(&*points, &members[c], mc) } else { (0.0, 0.0, Vec::new(), Vec::new()) })
    }).collect();
    let (mut w, mut mean, mut split): (Vec<f64>, Vec<[f32; 4]>, Vec<(f64, f64, Vec<u32>, Vec<u32>)>) = (Vec::with_capacity(k), Vec::with_capacity(k), Vec::with_capacity(k));
    for (wc, mc, s) in init { w.push(wc); mean.push(mc); split.push(s); }
    let mut gain: Vec<f64> = split.iter().map(|s| s.0).collect();
    let guard = exchange_rgb_guard();
    let dbg = std::env::var_os("SHOTQ_DEBUG").is_some();
    let mut why = "";
    let mut attempts = 0;
    let mergeable = |c: usize, opaque: &[bool], protected: &[bool], w: &[f64]| opaque[c] && !protected[c] && w[c] > 0.0;
    let partner_of = |c: usize, w: &[f64], mean: &[[f32; 4]], opaque: &[bool], protected: &[bool]| -> (f64, usize) {
        let mut best = (f64::MAX, usize::MAX);
        if !mergeable(c, opaque, protected, w) { return best; }
        for j in 0..k {
            if j == c || !mergeable(j, opaque, protected, w) { continue; }
            let cost = w[c] * w[j] / (w[c] + w[j]) * diff(&mean[c], &mean[j]) as f64;
            if cost < best.0 { best = (cost, j); }
        }
        best
    };
    let mut partner: Vec<(f64, usize)> = (0..k).map(|c| partner_of(c, &w, &mean, &opaque, &protected)).collect();
    let mut done = 0;
    while done < EXCHANGE_MAX && attempts < 4 * EXCHANGE_MAX {
        attempts += 1;
        let Some((s, g)) = (0..k).filter(|&c| gain[c] > 0.0).map(|c| (c, gain[c])).max_by(|a, b| a.1.partial_cmp(&b.1).unwrap().then(b.0.cmp(&a.0))) else { why = "no split with a gain"; break };
        let Some((mut i, (mut cost, mut j))) = (0..k).filter(|&c| partner[c].1 != usize::MAX).map(|c| (c, partner[c])).min_by(|a, b| a.1.0.partial_cmp(&b.1.0).unwrap().then(a.0.cmp(&b.0))) else { why = "no mergeable pair"; break };
        if g <= cost { why = "gain <= merge cost"; break; }
        if s == i || s == j {
            if !ex_next() { why = "best split is one of the cheapest pair"; break; }
            // SHOTQ_EX_NEXT=1 (P41, experiment): the cheapest pair that leaves the cluster to split alone
            let mut alt = (f64::MAX, usize::MAX, usize::MAX);
            for c in 0..k {
                if c == s || !mergeable(c, &opaque, &protected, &w) { continue; }
                for j2 in c + 1..k {
                    if j2 == s || !mergeable(j2, &opaque, &protected, &w) { continue; }
                    let cc = w[c] * w[j2] / (w[c] + w[j2]) * diff(&mean[c], &mean[j2]) as f64;
                    if cc < alt.0 { alt = (cc, c, j2); }
                }
            }
            if alt.1 == usize::MAX { why = "no mergeable pair apart from the split"; break; }
            if g <= alt.0 { why = "gain <= the next merge cost"; break; }
            i = alt.1; j = alt.2; cost = alt.0;
        }
        let _ = cost;
        if guard {
            let cost_ref = w[i] * w[j] / (w[i] + w[j]) * diff_report(&mean[i], &mean[j]) as f64;
            if split[s].1 < cost_ref { gain[s] = 0.0; continue; } // the reference error would rise: try the next split
        }
        let (lo, hi) = (i.min(j), i.max(j));
        // merge hi into lo
        let moved = std::mem::take(&mut members[hi]);
        for &p in &moved { points[p as usize].cluster = lo as u16; }
        members[lo].extend(moved);
        let (wl, ml) = wmean(points, &members[lo]); w[lo] = wl; mean[lo] = ml; centres[lo] = ml;
        split[lo] = split_of(points, &members[lo], ml); gain[lo] = split[lo].0;
        // split s: the second half takes the freed entry hi (the cached split of s, computed from the same members)
        let (a, b) = (std::mem::take(&mut split[s].2), std::mem::take(&mut split[s].3));
        for &p in &b { points[p as usize].cluster = hi as u16; }
        members[s] = a; members[hi] = b;
        opaque[hi] = opaque[s]; protected[hi] = false;
        for &c in &[s, hi] { let (wc, mc) = wmean(points, &members[c]); w[c] = wc; mean[c] = mc; centres[c] = mc; split[c] = split_of(points, &members[c], mc); gain[c] = split[c].0; }
        for c in 0..k { if c == lo || c == hi || c == s || [lo, hi, s].contains(&partner[c].1) { partner[c] = partner_of(c, &w, &mean, &opaque, &protected); } }
        done += 1;
    }
    if dbg { eprintln!("  quant: exchange stopped after {done} exchanges, {attempts} attempts: {}", if why.is_empty() { "the exchange limit" } else { why }); }
    done
}

// ---------------------------------------------------------------- 4. outlier rescue

/// A bin whose own error exceeds this many times the `--quality` max MSE gets a palette colour of its own.
/// Measured on 8 real screenshots at --quality 70-85 (M4 Max): 32 -> PSNR >= libimagequant on 5/8, +0.9% bytes;
/// 16 -> 8/8, +3.0%; 8 -> 8/8, +7% (over the 5% budget); 4 -> +12%.
const RESCUE_FACTOR: f64 = 16.0;
/// Bins seen fewer times than this in the sample are not rescued. With 1, single anti-aliasing pixels that the
/// jittered sampler happened to hit get colours too: +0.7% bytes for +0.1 dB, and it depends on sampling luck.
const RESCUE_MIN_N: f32 = 2.0;
/// Experiment knobs for the rescue and pin rules (P25 in docs/quantizer-plan.md): `SHOTQ_RESCUE` (factor, 0 = off),
/// `SHOTQ_RESCUE_N`, `SHOTQ_PIN_DIFF`, `SHOTQ_PIN_BIG`. Defaults are the constants above.
fn knob<T: std::str::FromStr + Copy>(name: &str, default: T) -> T { std::env::var(name).ok().and_then(|s| s.parse().ok()).unwrap_or(default) }
fn rescue_factor() -> f64 { static V: std::sync::OnceLock<f64> = std::sync::OnceLock::new(); *V.get_or_init(|| knob("SHOTQ_RESCUE", RESCUE_FACTOR)) }
fn rescue_min_n() -> f32 { static V: std::sync::OnceLock<f32> = std::sync::OnceLock::new(); *V.get_or_init(|| knob("SHOTQ_RESCUE_N", RESCUE_MIN_N)) }
fn pin_min_diff() -> f32 { static V: std::sync::OnceLock<f32> = std::sync::OnceLock::new(); *V.get_or_init(|| knob("SHOTQ_PIN_DIFF", PIN_MIN_DIFF)) }
fn pin_big() -> f32 { static V: std::sync::OnceLock<f32> = std::sync::OnceLock::new(); *V.get_or_init(|| knob("SHOTQ_PIN_BIG", PIN_BIG)) }
/// An exchange at 256 colours is applied only if it also does not raise the reference error (no luminance term):
/// a split whose reference gain is below the merge's reference cost is skipped (0.14.0). Measured on the images
/// that use all 256 colours: the same RGB PSNR, luma -0.06..-0.15 dB, bytes -0.2..-6.1% (the owner's 10-05-03
/// -6.1%). `SHOTQ_EX_RGB=0` disables the guard.
/// Text mixes (P29) are added when their nearest centre is farther than this times the quality target; 0 disables.
/// Measured on the real screenshots: 4 adds 0-4 entries per image for +0.1 dB and +0.1% bytes, 1 adds up to 17
/// (helix 130 -> 141, kitty 183 -> 200) for +0.33 dB RGB, +0.26 dB luma, +0.24 dB on neutral pixels and +0.4%
/// bytes, a better rate than the --quality dial (2.5% bytes per 0.5 dB). `SHOTQ_MIX` overrides.
const MIX_FAR: f64 = 1.0;
fn mix_far() -> f64 { static V: std::sync::OnceLock<f64> = std::sync::OnceLock::new(); *V.get_or_init(|| knob("SHOTQ_MIX", MIX_FAR).max(0.0)) }
/// Pre-pins (P31, experiment): flat colours with at least this share of the sample become fixed palette entries
/// *before* the divisive step (they leave the Wu boxes and k-means never moves them), heaviest first, at most
/// PIN_PRE_MAX of them. 0 = off (the pin rule of P2 runs after k-means as before). `SHOTQ_PIN_PRE` overrides.
/// Measured and not adopted (HANDOFF P31): alone it separates a flat colour from the near shades that the snap
/// rule folds into it, so the index stream gains transitions (+10% bytes on the real screenshots, +12% on the
/// owner's); with the near shades taken along (`SHOTQ_PIN_PRE_R=2`, their error left out of the stop test,
/// `SHOTQ_PIN_PRE_E=0`) it is a wash at equal bytes (+0.1..0.3 dB, false contours equal, colour casts on neutral
/// pixels up by 1-2 levels where a tinted flat colour absorbs them).
const PIN_PRE: f64 = 0.0;
const PIN_PRE_MAX: usize = 128;
fn pin_pre() -> f64 { static V: std::sync::OnceLock<f64> = std::sync::OnceLock::new(); *V.get_or_init(|| knob("SHOTQ_PIN_PRE", PIN_PRE).max(0.0)) }
/// With `SHOTQ_PIN_PRE_R=r` > 0, the points within r code levels (every channel) of a pre-pinned colour leave the
/// split with it and are served by its entry (what the snap rule does after k-means for a cluster the flat
/// colour dominates); their error counts in the stop test.
fn pin_pre_r() -> f32 { static V: std::sync::OnceLock<f32> = std::sync::OnceLock::new(); *V.get_or_init(|| knob("SHOTQ_PIN_PRE_R", 0f32).max(0.0)) }
/// Banding guard (P27, 0.17.0): once the error target is met, keep cutting the box that takes part in the most
/// visible steps while more than this fraction of the smooth 1-level neighbour pairs of the sample (`Hist.pairs`)
/// land in boxes whose mean luma differs by at least `BAND_T` code levels (the false-contour rule of
/// `tools/grey.py`). At 0.10 it touches only images with severe banding (the ramps and youtube-music of the
/// bench set: +2..22% bytes, false contours halved or better) and nothing else; 0.03 at equal bytes trades 0.6 dB
/// on text and UI for 13% fewer contours and was not taken. 0 = off. `SHOTQ_BAND`, `SHOTQ_BAND_T` override.
const BAND_MAX: f64 = 0.10;
const BAND_T: f64 = 3.0;
pub fn band_max() -> f64 { static V: std::sync::OnceLock<f64> = std::sync::OnceLock::new(); *V.get_or_init(|| knob("SHOTQ_BAND", BAND_MAX).max(0.0)) }
fn band_thr() -> f64 { static V: std::sync::OnceLock<f64> = std::sync::OnceLock::new(); *V.get_or_init(|| knob("SHOTQ_BAND_T", BAND_T).max(0.0)) }
/// Luma of a box mean in 8-bit code levels.
fn code_luma(mean: &[f64; 4], space: &ColorSpace) -> f64 {
    if mean[0] <= 0.0 { return 0.0; }
    let code = |d: usize| space.decode((mean[d + 1] / (mean[0] * W[d] as f64)).clamp(0.0, 1.0) as f32) as f64;
    0.2126 * code(0) + 0.7152 * code(1) + 0.0722 * code(2)
}
/// Text mixes at 256 colours (P30): when every entry is in use, a mix that no centre is close to can take the
/// entry freed by merging the two clusters cheapest to merge (Ward cost, as in `exchange`). 0 = never (mixes
/// are added only while slots remain, P29); 1 = the pair cheapest in the design metric, always; 2 = that pair,
/// only when the sample error the mix removes exceeds the cost; 3 = the pair cheapest in the reference metric,
/// always; 4 = that pair, only when the reference gain exceeds the reference cost; 5 = as 3 but only clusters
/// made mostly of smooth, non-neutral pixels (gradients, photographs) may be merged. `SHOTQ_MIX_EX` overrides.
/// Measured and not adopted (HANDOFF P30): on the real screenshots at 256 colours the sample's own accounting
/// says the merges are not worth it (2 and 4 never fire), 1 and 3 merge the light clusters, which are UI greys
/// and text colours, so neutral pixels lose 0.2-5 dB; 5 helps only synthetic grey text over a colourful gradient
/// (+14 dB on neutral pixels) and is a wash on tabby (-1% bytes, neutral +0.3, luma -0.1, contours +8%).
const MIX_EXCHANGE: u32 = 0;
fn mix_exchange() -> u32 { static V: std::sync::OnceLock<u32> = std::sync::OnceLock::new(); *V.get_or_init(|| knob("SHOTQ_MIX_EX", MIX_EXCHANGE)) }
/// Cap on one merge: its reference-error cost over the sample weight must not exceed this times the `--quality`
/// max MSE (0 = no cap). `SHOTQ_MIX_EX_CAP` overrides.
const MIX_EX_CAP: f64 = 0.0;
fn mix_ex_cap() -> f64 { static V: std::sync::OnceLock<f64> = std::sync::OnceLock::new(); *V.get_or_init(|| knob("SHOTQ_MIX_EX_CAP", MIX_EX_CAP).max(0.0)) }
/// Cluster statistics for freeing entries at 256 colours: design weight and mean per cluster, and which clusters
/// may not be merged (translucent, dominated by a heavy exact colour, or holding a fixed entry).
struct MixSlots { w: Vec<f64>, mean: Vec<[f32; 4]>, locked: Vec<bool>, merges: usize, cap: f64 }
impl MixSlots {
    /// Uses the clusters and errors of the last assignment (one Lloyd step behind the centres: close enough for
    /// the merge costs, and nothing moves when no entry is freed).
    fn new(points: &[Point], centres: &[[f32; 4]], fixed: &[Option<[f32; 4]>], total: usize, big: f32, target_ref: f64, space: &ColorSpace, mode: u32) -> Self {
        let k = centres.len();
        let total_w: f64 = points.iter().map(|p| p.w as f64).sum();
        let cap = if mix_ex_cap() > 0.0 { mix_ex_cap() * target_ref * total_w } else { f64::MAX };
        let (mut w, mut wp, mut s, mut cn, mut heavy, mut trans) = (vec![0f64; k], vec![0f64; k], vec![[0f64; 4]; k], vec![0f32; k], vec![0f32; k], vec![false; k]);
        for p in points.iter() {
            let c = p.cluster as usize;
            w[c] += p.wd(); wp[c] += p.w as f64; for d in 0..4 { s[c][d] += p.wd() * p.v[d] as f64; }
            cn[c] += p.n; if p.exact { heavy[c] = heavy[c].max(p.n); } if p.cell == u32::MAX { trans[c] = true; }
        }
        let mean: Vec<[f32; 4]> = (0..k).map(|c| s[c].map(|x| (x / w[c].max(1e-30)) as f32)).collect();
        // mode 5: only clusters made mostly of smooth pixels (mean context weight >= 2: gradients, photographs)
        // that are not neutral may be merged; UI greys and text colours, which are what the mixes serve, stay
        let smooth_chroma = |c: usize| mode < 5 || (w[c] >= 2.0 * wp[c] && !is_neutral(&mean[c].map(|x| x as f64), space));
        let locked = (0..k).map(|c| trans[c] || fixed[c].is_some() || w[c] <= 0.0 || heavy[c] > 0.5 * cn[c] || heavy[c] >= big * total as f32 || !smooth_chroma(c)).collect();
        MixSlots { w, mean, locked, merges: 0, cap }
    }
    /// Merge the cheapest pair and return the freed entry, or None when nothing may be merged or (mode 2) the
    /// mix `v` is not worth the merge.
    fn free(&mut self, points: &mut [Point], centres: &mut [[f32; 4]], mode: u32, v: &[f32; 4]) -> Option<usize> {
        let k = centres.len();
        // modes 1 and 2 pick the pair cheapest in the design metric, mode 3 in the reference metric (no luminance
        // term: the design metric makes two tints at one luminance the cheapest merge, which casts neutral pixels)
        let metric = |a: &[f32; 4], b: &[f32; 4]| if mode >= 3 { diff_report(a, b) } else { diff(a, b) };
        let mut best = (f64::MAX, usize::MAX, usize::MAX);
        for i in 0..k {
            if self.locked[i] { continue; }
            for j in i + 1..k {
                if self.locked[j] { continue; }
                let cost = self.w[i] * self.w[j] / (self.w[i] + self.w[j]) * metric(&self.mean[i], &self.mean[j]) as f64;
                if cost < best.0 { best = (cost, i, j); }
            }
        }
        let (cost, lo, hi) = best;
        if lo == usize::MAX { return None; }
        let cost_ref = self.w[lo] * self.w[hi] / (self.w[lo] + self.w[hi]) * diff_report(&self.mean[lo], &self.mean[hi]) as f64;
        let dbg = std::env::var_os("SHOTQ_DEBUG").is_some();
        if mode == 2 || mode == 4 || dbg {
            let gain: f64 = points.iter().map(|p| { let d = diff(&p.v, v); if d < p.d { p.wd() * (p.d - d) as f64 } else { 0.0 } }).sum();
            // mode 4: the exchange's own rule, on the reference metric: the sample error the mix removes must
            // exceed what the merge adds, both without the luminance term
            let gain_ref: f64 = if mode == 4 || dbg { points.iter().map(|p| { let d = diff_report(&p.v, v); let old = diff_report(&p.v, &centres[p.cluster as usize]); if d < old { p.wd() * (old - d) as f64 } else { 0.0 } }).sum() } else { 0.0 };
            if dbg { eprintln!("    mix merge: cost {cost:.3e} ref {cost_ref:.3e} = {:.2}% of cap (clusters {lo} + {hi}, weights {:.0} + {:.0}), sample gain {gain:.3e} ref {gain_ref:.3e}", 100.0 * cost_ref / self.cap, self.w[lo], self.w[hi]); }
            if mode == 2 && gain <= cost { return None; }
            if mode == 4 && gain_ref <= cost_ref { return None; }
        }
        if cost_ref > self.cap { return None; }
        let (wl, wh) = (self.w[lo], self.w[hi]);
        let mean = [0, 1, 2, 3].map(|d| ((wl * self.mean[lo][d] as f64 + wh * self.mean[hi][d] as f64) / (wl + wh)) as f32);
        self.w[lo] = wl + wh; self.mean[lo] = mean; centres[lo] = mean;
        for p in points.iter_mut() {
            if p.cluster as usize == hi { p.cluster = lo as u16; }
            if p.cluster as usize == lo { p.d = diff(&p.v, &mean); }
        }
        self.w[hi] = 0.0; self.locked[hi] = true; self.merges += 1;
        Some(hi)
    }
}
/// SHOTQ_EX_AXIS=1: the exchange's split axis in the metric's whitened coordinates with the exact 1-D cut (P41).
pub fn ex_axis() -> bool { static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new(); *V.get_or_init(|| std::env::var("SHOTQ_EX_AXIS").map_or(false, |s| s == "1")) }
/// SHOTQ_EX_NEXT=1: when the best split is one of the cheapest pair, take the next cheapest pair instead of stopping (P41).
pub fn ex_next() -> bool { static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new(); *V.get_or_init(|| std::env::var("SHOTQ_EX_NEXT").map_or(false, |s| s == "1")) }
fn exchange_rgb_guard() -> bool { static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new(); *V.get_or_init(|| knob("SHOTQ_EX_RGB", 1u32) != 0) }

/// `--quality max` stops the splitting on the *average* error, so with few colours a small accent colour (a status
/// dot, an icon, pure black on a dark theme) can be folded into a neighbour with an error the average never
/// notices. While palette slots are spare, the bin with the largest own error above `thr` becomes a colour.
/// The error is the design metric's (with the luminance term): measuring it on the reference metric instead was
/// tried in P19 and rejected, it saved 0.5-2.7% of bytes for 0.5-1.8 dB of PSNR on the real screenshots.
/// Cost is O(candidates x added colours): a point within the threshold can never become a candidate, so only the
/// candidates are re-examined after each addition; the exact assignment that follows fixes up everything else.
/// Returns the number of colours added. Deterministic: ties go to the lowest index.
fn rescue(points: &mut [Point], centres: &mut Vec<[f32; 4]>, thr: f32, min_n: f32) -> usize {
    let mut cand: Vec<usize> = points.iter().enumerate().filter(|(_, p)| p.n >= min_n && p.d > thr).map(|(i, _)| i).collect();
    let before = centres.len();
    while centres.len() < K_MAX && !cand.is_empty() {
        let (mut wi, mut wd) = (0usize, -1f32);
        for &i in &cand { if points[i].d > wd { wd = points[i].d; wi = i; } }
        let c = points[wi].v;
        let k = centres.len() as u16;
        centres.push(c);
        cand.retain(|&i| { let p = &mut points[i]; let d = diff(&p.v, &c); if d < p.d { p.d = d; p.cluster = k; } p.d > thr });
    }
    centres.len() - before
}

// ---------------------------------------------------------------- driver

/// `mixes`: candidate colours of text anti-aliasing (P29, `mix_candidates` in main.rs): each one farther than
/// MIX_FAR times the quality target from every centre gets a fixed palette entry of its own, while slots remain.
pub fn quantize(space: &ColorSpace, hist: Hist, qmin: u8, qmax: u8, iterations: usize, mixes: &[Rgba]) -> Result<Quantized, u8> {
    let t0 = std::time::Instant::now();
    let dbg = std::env::var_os("SHOTQ_DEBUG").is_some();
    let (mut opaque, mut trans, total, raw_pairs) = hist.into_points(space);
    // No single colour may carry more than 10% of the total weight (libimagequant does the same). A huge flat background is
    // reproduced exactly anyway; without the cap it would hide the error everywhere else (and inflate the quality).
    // The cap applies per colour cell: a cell split into an exact colour and its remainder is scaled as a whole,
    // otherwise the split would let a background weigh more than before and stop the splitting earlier.
    let cap = 0.1 * total as f32;
    let mut cell_n: HashMap<u32, f32, BuildHasherDefault<MulHasher>> = HashMap::default();
    for p in opaque.iter().filter(|p| p.exact) { *cell_n.entry(p.cell).or_insert(0.0) += p.n; }
    for p in opaque.iter().filter(|p| !p.exact) { if let Some(n) = cell_n.get_mut(&p.cell) { *n += p.n; } }
    for p in opaque.iter_mut() { let n = cell_n.get(&p.cell).copied().unwrap_or(p.n); p.w = p.n * (cap / n).min(1.0); }
    for p in trans.iter_mut() { p.w = p.w.min(cap); }
    if dbg { eprintln!("  quant: bins -> points {:?} ({} opaque bins, {} translucent)", t0.elapsed(), opaque.len(), trans.len()); }
    let a_opaque = space.conv(0, 0, 0, 255)[0];
    // Splitting stops once the box-variance estimate meets --quality max. k-means only lowers the error from
    // there, so the final quality lands at or just above the requested maximum, with as few colours as possible.
    let target = if qmax >= 100 { 0.0 } else { quality_to_mse(qmax) * stop_scale() };
    // 2b. pre-pins (P31): the heaviest flat colours leave the split and get fixed entries of their own
    let mut pinned: Vec<Point> = Vec::new(); // the pre-pinned colours (n_pins of them, in rank order), then their near shades
    let mut n_pins = 0usize;
    // The pre-pin path drops pairs by the point numbers of this `opaque` and keeps the total from before the drop,
    // so it maps the colour pairs now; by default they stay as recorded until the banding rule needs them (P45).
    let mut pairs = if pin_pre() > 0.0 { let (pairs, total) = pairs_to_points(raw_pairs, &opaque); Pairs::Points { pairs, total } } else { Pairs::Raw(raw_pairs) };
    if pin_pre() > 0.0 {
        let thr = (pin_pre() * total as f64) as f32;
        let mut idx: Vec<usize> = opaque.iter().enumerate().filter(|(_, p)| p.exact && p.n >= thr).map(|(i, _)| i).collect();
        idx.sort_by(|&a, &b| opaque[b].n.partial_cmp(&opaque[a].n).unwrap().then(a.cmp(&b)));
        idx.truncate(PIN_PRE_MAX.min(K_MAX - 1));
        n_pins = idx.len();
        if !idx.is_empty() {
            let mut take = vec![u32::MAX; opaque.len()]; // which pre-pin (by rank) a point belongs to
            for (r, &i) in idx.iter().enumerate() { take[i] = r as u32; }
            let radius = pin_pre_r();
            if radius > 0.0 {
                // near shades go with the nearest pre-pinned colour (within `radius` levels in every channel)
                for (i, p) in opaque.iter().enumerate() {
                    if take[i] != u32::MAX || p.cell == u32::MAX { continue; }
                    let mut best: Option<(f32, u32)> = None;
                    for (r, &j) in idx.iter().enumerate() {
                        let q = &opaque[j];
                        let d = (0..3).map(|c| (p.rgba[c] - q.rgba[c]).abs()).fold(0f32, f32::max);
                        if d <= radius && best.map_or(true, |b| d < b.0) { best = Some((d, r as u32)); }
                    }
                    if let Some((_, r)) = best { take[i] = r; }
                }
            }
            let mut newidx = vec![u32::MAX; opaque.len()];
            let (mut rest, mut n) = (Vec::with_capacity(opaque.len()), 0u32);
            let mut near: Vec<Point> = Vec::new();
            for (i, p) in opaque.into_iter().enumerate() {
                if take[i] == u32::MAX { newidx[i] = n; n += 1; rest.push(p); }
                else if p.exact && idx.contains(&i) { pinned.push(p); }
                else { let mut p = p; p.cluster = take[i] as u16; near.push(p); } // cluster = pre-pin rank for now
            }
            opaque = rest;
            if let Pairs::Points { pairs: pp, .. } = &mut pairs { *pp = std::mem::take(pp).into_iter().filter(|p| newidx[p.0 as usize] != u32::MAX && newidx[p.1 as usize] != u32::MAX).map(|p| (newidx[p.0 as usize], newidx[p.1 as usize], p.2)).collect(); }
            pinned.extend(near); // the pinned colours first (in rank order), then their near shades
        }
    }
    let extra_w: f64 = pinned.iter().map(|p| if ctx_tight() { p.w as f64 } else { p.wd() }).sum();
    // the near shades' error counts in the stop test unless SHOTQ_PIN_PRE_E=0 (the snap rule of P2 moves a cluster
    // onto its flat colour after the stop test, so that error was never held to the target)
    let extra_err: f64 = if knob("SHOTQ_PIN_PRE_E", 1u8) == 0 { 0.0 } else { pinned.iter().skip(n_pins).map(|p| { let q = &pinned[p.cluster as usize]; p.wd() * diff(&p.v, &q.v) as f64 }).sum() };
    let mut centres = divide(&mut opaque, &mut trans, a_opaque, target, space, pairs, extra_w, extra_err, K_MAX - n_pins);
    let mut fixed: Vec<Option<[f32; 4]>> = vec![None; centres.len()]; // per centre: the exact colour it must keep
    let base = centres.len();
    for p in pinned.iter_mut().take(n_pins) { p.cluster = centres.len() as u16; centres.push(p.v); fixed.push(Some(p.rgba)); }
    for p in pinned.iter_mut().skip(n_pins) { p.cluster = base as u16 + p.cluster; } // near shades: their pre-pin's centre
    let mut points = opaque;
    points.append(&mut pinned);
    points.append(&mut trans);
    if dbg { eprintln!("  quant: split into {} colours ({} pre-pinned) at {:?}", centres.len(), fixed.iter().filter(|f| f.is_some()).count(), t0.elapsed()); }

    // Lloyd step; centres with a fixed colour (pre-pins) stay where they are
    let lloyd = |points: &mut [Point], centres: &mut Vec<[f32; 4]>, fixed: &[Option<[f32; 4]>]| {
        let sums = assign::<true>(points, centres);
        for (c, (s, f)) in centres.iter_mut().zip(sums.iter().zip(fixed)) {
            if s[0] > 0.0 && f.is_none() { *c = [(s[1] / s[0]) as f32, (s[2] / s[0]) as f32, (s[3] / s[0]) as f32, (s[4] / s[0]) as f32]; }
        }
    };
    for _ in 0..iterations { lloyd(&mut points, &mut centres, &fixed); }
    if dbg { eprintln!("  quant: k-means done at {:?}", t0.elapsed()); }

    // 3b. at 256 colours, trade entries between clusters that are cheap to merge and clusters that split well (P23);
    //     clusters a flat colour dominates are kept for the snap step
    if centres.len() == K_MAX {
        let k = centres.len();
        let (mut cn, mut heavy_exact) = (vec![0f32; k], vec![0f32; k]);
        for p in points.iter() { let c = p.cluster as usize; cn[c] += p.n; if p.exact { heavy_exact[c] = heavy_exact[c].max(p.n); } }
        let protected: Vec<bool> = (0..k).map(|c| fixed[c].is_some() || heavy_exact[c] > 0.5 * cn[c] || heavy_exact[c] >= pin_big() * total as f32).collect();
        let ex = exchange(&mut points, &mut centres, &protected);
        if ex > 0 { lloyd(&mut points, &mut centres, &fixed); }
        if dbg { eprintln!("  quant: {ex} exchanges at 256 colours at {:?}", t0.elapsed()); }
    }

    // 4. rescue: spare palette slots go to the bins that are reproduced worst (only when the split stopped early).
    //    One more Lloyd step then lets the new colours settle on the mean of what they attracted (+0.5 dB, same size).
    if target > 0.0 && centres.len() < K_MAX {
        assign::<false>(&mut points, &centres); // fresh errors against the final k-means centres
        let thr = (rescue_factor() * target) as f32;
        let added = if rescue_factor() > 0.0 { rescue(&mut points, &mut centres, thr, rescue_min_n()) } else { 0 };
        fixed.resize(centres.len(), None);
        if added > 0 { lloyd(&mut points, &mut centres, &fixed); }
        if dbg { eprintln!("  quant: rescue added {added} colours (threshold {thr:.5}) at {:?}", t0.elapsed()); }
    }

    // Per cluster: total sample count and its heaviest point, by uncapped counts (the 10% cap is for the error
    // metric; whether a flat colour dominates its cluster is a question about pixels). The snap rule below makes
    // that point's colour exact when it holds at least half of the cluster.
    let cluster_counts = |points: &[Point], k: usize| {
        let (mut cn, mut heavy) = (vec![0f32; k], vec![(0f32, usize::MAX); k]);
        for (i, p) in points.iter().enumerate() {
            let c = p.cluster as usize;
            cn[c] += p.n;
            if p.n > heavy[c].0 { heavy[c] = (p.n, i); }
        }
        (cn, heavy)
    };
    // Strictly more than half: two equally heavy colours in one cluster (a tie) are better served by their mean, which
    // halves the squared error, than by one of them exactly.
    let snapped = |cn: &[f32], heavy: &[(f32, usize)], c: usize| heavy[c].1 != usize::MAX && heavy[c].0 > 0.5 * cn[c];

    // 5. pin: a flat colour with >= EXACT_MIN of the sample is a UI colour (background, panel, table stripe). If the
    //    colour its cluster is going to produce is >= PIN_MIN_DIFF away in some channel and in the same cell (or
    //    the flat colour is big), it gets a centre of its own that keeps exactly its colour, heaviest first.
    //    No error-based rule could do this: #000000 and #030303 are 1.3e-4 apart in this space, 40x below the
    //    rescue threshold at --quality 85; libimagequant and pngquant merge them too.
    fixed.resize(centres.len(), None);
    // 4b. text mixes (P29): the shades of anti-aliased text between a background and a foreground colour, found by
    //     the row scan, get fixed entries when no centre is within MIX_FAR times the target (about 2 levels at
    //     --quality 85): a general entry a few levels off tints or lightens the whole edge of a glyph.
    let mut added_mixes = 0;
    if mix_far() > 0.0 && !mixes.is_empty() {
        let thr = (mix_far() * quality_to_mse(qmax.min(99).max(1))) as f32;
        let mut slots: Option<MixSlots> = None; // built on first use, at 256 colours only (P30)
        for m in mixes {
            if centres.len() >= K_MAX && mix_exchange() == 0 { break; }
            let v = space.conv(m.r, m.g, m.b, 255);
            let near = centres.iter().map(|c| diff(&v, c)).fold(f32::MAX, f32::min);
            if near <= thr { continue; }
            let rgba = [m.r as f32, m.g as f32, m.b as f32, 255.0];
            if centres.len() < K_MAX { centres.push(v); fixed.push(Some(rgba)); added_mixes += 1; continue; }
            // 256 colours: the mix takes the entry freed by merging the two clusters cheapest to merge
            let mode = mix_exchange();
            let st = slots.get_or_insert_with(|| MixSlots::new(&points, &centres, &fixed, total, pin_big(), quality_to_mse(qmax.min(99).max(1)), space, mix_exchange()));
            let Some(slot) = st.free(&mut points, &mut centres, mode, &v) else { if mode == 2 || mode == 4 { continue } else { break } };
            centres[slot] = v; fixed[slot] = Some(rgba); added_mixes += 1;
        }
        if added_mixes > 0 { assign::<false>(&mut points, &centres); }
        if dbg { eprintln!("  quant: {added_mixes} of {} text mixes added ({} merges at 256 colours) at {:?}", mixes.len(), slots.as_ref().map_or(0, |s| s.merges), t0.elapsed()); }
    }
    if centres.len() < K_MAX && points.iter().any(|p| p.exact) {
        let (cn, heavy) = cluster_counts(&points, centres.len());
        let would_be = |c: usize| -> [f32; 3] {
            if snapped(&cn, &heavy, c) { let m = points[heavy[c].1].rgba; [m[0].round(), m[1].round(), m[2].round()] }
            else { let q = space.to_rgba(centres[c]); [q.r as f32, q.g as f32, q.b as f32] }
        };
        let cell_of = |c: [f32; 3]| ((c[0] as u32) >> 2) << 12 | ((c[1] as u32) >> 2) << 6 | (c[2] as u32) >> 2;
        let mut pins: Vec<usize> = points.iter().enumerate()
            .filter(|&(_, p)| p.exact && {
                let r = would_be(p.cluster as usize);
                (0..3).any(|d| (p.rgba[d] - r[d]).abs() >= pin_min_diff()) && (cell_of(r) == p.cell || p.n >= pin_big() * total as f32)
            })
            .map(|(i, _)| i).collect();
        pins.sort_by(|&a, &b| points[b].n.partial_cmp(&points[a].n).unwrap().then(a.cmp(&b)));
        pins.truncate(K_MAX - centres.len());
        let instead: Vec<[f32; 3]> = pins.iter().map(|&i| would_be(points[i].cluster as usize)).collect();
        for (&i, wb) in pins.iter().zip(&instead) {
            let p = &points[i];
            if dbg { eprintln!("    pin {:?} {:.2}% of the sample, cluster would give {:?}", p.rgba.map(|x| x as u8), p.n / total as f32 * 100.0, wb.map(|x| x as u8)); }
            centres.push(p.v);
            fixed.push(Some(p.rgba));
        }
        if !pins.is_empty() { assign::<false>(&mut points, &centres); }
        if dbg { eprintln!("  quant: pinned {} of {} exact colours at {:?}", pins.len(), points.iter().filter(|p| p.exact).count(), t0.elapsed()); }
    }

    // 6. snap: if one histogram bin carries at least half of a cluster's samples, use exactly that colour
    let k = centres.len();
    let (cn, heavy) = cluster_counts(&points, k);
    let palette: Vec<Rgba> = (0..k).map(|c| {
        if let Some(m) = fixed[c].or_else(|| snapped(&cn, &heavy, c).then(|| points[heavy[c].1].rgba)) {
            let r = |f: f32| f.round().clamp(0.0, 255.0) as u8;
            Rgba { r: r(m[0]), g: r(m[1]), b: r(m[2]), a: r(m[3]) }
        } else {
            space.to_rgba(centres[c])
        }
    }).collect();

    // Entries that rounded to the same colour are merged: the duplicate would never be chosen and its slot is
    // wasted, which matters when all 256 are in use (P19).
    let exact_entry: Vec<bool> = (0..k).map(|c| fixed[c].is_some() || snapped(&cn, &heavy, c)).collect();
    let mut first: HashMap<u32, u16, BuildHasherDefault<MulHasher>> = HashMap::default();
    let mut newidx = vec![0u16; k];
    let mut kept: Vec<Rgba> = Vec::with_capacity(k);
    let mut locked: Vec<bool> = Vec::with_capacity(k);
    for (i, c) in palette.iter().enumerate() {
        newidx[i] = *first.entry(u32::from_le_bytes([c.r, c.g, c.b, c.a])).or_insert_with(|| { kept.push(*c); locked.push(false); (kept.len() - 1) as u16 });
        locked[newidx[i] as usize] |= exact_entry[i];
    }
    for p in points.iter_mut() { p.cluster = newidx[p.cluster as usize]; }
    if dbg && kept.len() < k { eprintln!("  quant: {} duplicate palette entries merged", k - kept.len()); }
    let (mut palette, k) = (kept, kept_len(&newidx));
    // transparent entries first (shorter tRNS); then measure against the *rounded* palette that will be written
    let mut order: Vec<usize> = (0..k).collect();
    order.sort_by_key(|&i| palette[i].a == 255);
    let mut rank = vec![0u16; k];
    for (new, &old) in order.iter().enumerate() { rank[old] = new as u16; }
    palette = order.iter().map(|&i| palette[i]).collect();
    let locked: Vec<bool> = order.iter().map(|&i| locked[i]).collect();
    for p in points.iter_mut() { p.cluster = rank[p.cluster as usize]; }
    let finals: Vec<[f32; 4]> = palette.iter().map(|c| space.conv(c.r, c.g, c.b, c.a)).collect();
    assign::<false>(&mut points, &finals);
    let total_w: f64 = points.iter().map(|p| p.w as f64).sum();
    if dbg { eprintln!("  quant: snap + final assignment done at {:?}", t0.elapsed()); }

    // 7. quality: weighted mean squared colour difference of the sample -> 0..100, on the 0.8.0 metric (no
    //    luminance term): the number and the --quality floor keep their meaning across the P16 change
    let err: f64 = points.iter().map(|p| p.w as f64 * diff_report(&p.v, &finals[p.cluster as usize]) as f64).sum();
    let mse = err / total_w;
    let quality = mse_to_quality(mse);
    if dbg { eprintln!("  quant: done {:?}, sample mse {:.3e} (RMS {:.2} of 255) -> quality {}", t0.elapsed(), mse, mse.sqrt() * 255.0, quality); }
    if quality < qmin { return Err(quality); }
    // A cell whose points went to different palette entries (an exact colour and the rest of its cell) is marked
    // CELL_SLOW: the remapper then resolves every pixel of that cell exactly instead of by cell.
    let mut cells: Vec<(u32, u16)> = points.iter().filter(|p| p.cell != u32::MAX).map(|p| (p.cell, p.cluster)).collect();
    cells.sort_unstable();
    cells.dedup_by(|later, kept| later.0 == kept.0 && { if later.1 != kept.1 { kept.1 = CELL_SLOW; } true });
    Ok(Quantized { palette, quality, cells, points: points.len(), locked })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(x: &mut u32) -> u32 { *x = x.wrapping_mul(1664525).wrapping_add(1013904223); *x >> 8 }

    #[test]
    fn quality_curve_round_trips_and_is_monotonic() {
        for q in 1..100u8 {
            assert_eq!(mse_to_quality(quality_to_mse(q)), q);
            assert!(quality_to_mse(q) > quality_to_mse(q + 1));
        }
    }

    /// The pruned assignment must give exactly the result of checking every centre.
    #[test]
    fn pruned_assignment_is_exact() {
        let space = ColorSpace::new();
        let mut seed = 7u32;
        let centres: Vec<[f32; 4]> = (0..256).map(|i| {
            let a = if i % 9 == 0 { (lcg(&mut seed) % 256) as u8 } else { 255 };
            space.conv((lcg(&mut seed) % 256) as u8, (lcg(&mut seed) % 256) as u8, (lcg(&mut seed) % 256) as u8, a)
        }).collect();
        let mut points: Vec<Point> = (0..20_000).map(|i| {
            let a = if i % 13 == 0 { (lcg(&mut seed) % 256) as u8 } else { 255 };
            let c = [(lcg(&mut seed) % 256) as f32, (lcg(&mut seed) % 256) as f32, (lcg(&mut seed) % 256) as f32, a as f32];
            Point { v: space.conv_f(c[0], c[1], c[2], c[3]), rgba: c, w: 1.0, b: 1.0, nf: 1.0, cell: 0, cluster: (lcg(&mut seed) % 256) as u16, n: 1.0, d: 0.0, exact: false }
        }).collect();
        assign::<false>(&mut points, &centres);
        let nb = neighbours(&centres, luma());
        for (i, p) in points.iter().enumerate() {
            let (mut bj, mut bd) = (0usize, f32::MAX);
            for (j, c) in centres.iter().enumerate() { let d = diff(&p.v, c); if d < bd { bd = d; bj = j; } }
            assert_eq!(p.cluster as usize, bj);
            // and the answer must not depend on the starting guess
            assert_eq!(search(&centres, &nb, &p.v, (i * 31) % 256, luma()).0, bj);
        }
    }

    /// A saturated accent colour covering 0.01% of the samples must get its own palette entry even though the
    /// average error already meets --quality max with a handful of colours (backlog P1: outlier rescue).
    /// Without the rescue step this palette has 5 colours and the red is folded into the dark panel.
    #[test]
    fn small_accent_colour_gets_its_own_palette_entry() {
        let mut h = Hist::new();
        let mut seed = 3u32;
        for i in 0..400_000u32 {
            let k = match i % 10_000 {
                0 => u32::from_le_bytes([230, 30, 30, 255]),                                   // 0.01%: red status dot
                1..=6000 => u32::from_le_bytes([245, 245, 247, 255]),                          // light background
                6001..=9000 => u32::from_le_bytes([40, 40, 46, 255]),                          // dark panel
                _ => { let g = 120 + (lcg(&mut seed) % 24) as u8; u32::from_le_bytes([g, g, g + 2, 255]) } // soft grey text
            };
            h.push(k);
        }
        let q = quantize(&ColorSpace::new(), h, 0, 85, 1, &[]).ok().unwrap();
        assert!(q.palette.len() < 32, "expected a small palette, got {}", q.palette.len());
        let near = q.palette.iter().filter(|c| c.a == 255).map(|c| (c.r as i32 - 230).abs() + (c.g as i32 - 30).abs() + (c.b as i32 - 30).abs()).min().unwrap();
        assert!(near <= 6, "red accent not preserved: nearest palette colour is {near} steps away, palette {:?}", q.palette);
    }

    /// Two flat colours in one 6-bit cell (#FFFFFF/#FCFCFC stripes, a #000000 block on #030303) must both come back
    /// exactly, although the cell's mean would be one colour (backlog P2). Runs tell flat colours from
    /// anti-aliasing, so the histogram is fed row by row like the sampler does.
    #[test]
    fn same_cell_flat_colours_are_kept_apart() {
        let mut h = Hist::new();
        let mut seed = 5u32;
        let px = |r: u8, g: u8, b: u8| u32::from_le_bytes([r, g, b, 255]);
        for row in 0..500u32 {
            for x in 0..40u32 { h.push(if (150..350).contains(&row) && (10..30).contains(&x) { px(0, 0, 0) } else { px(3, 3, 3) }); }
            let stripe = if (row / 14) % 2 == 0 { px(255, 255, 255) } else { px(252, 252, 252) };
            for x in 0..600u32 {
                h.push(if x % 37 == 5 { let g = 60 + (lcg(&mut seed) % 120) as u8; px(g, g, g) } else { stripe }); // "text"
            }
            h.end_row();
        }
        let q = quantize(&ColorSpace::new(), h, 0, 85, 1, &[]).ok().unwrap();
        assert!(q.palette.len() < K_MAX);
        for want in [[255, 255, 255], [252, 252, 252], [3, 3, 3], [0, 0, 0]] {
            assert!(q.palette.iter().any(|c| [c.r, c.g, c.b] == want && c.a == 255), "{want:?} missing from {:?}", q.palette);
        }
        for cell in [0u32, (63 << 12) | (63 << 6) | 63] { // the remapper must resolve these two cells per pixel
            assert!(q.cells.iter().any(|&(c, i)| c == cell && i == CELL_SLOW), "cell {cell} not marked CELL_SLOW");
        }
    }

    /// A black shadow with 60 alpha steps keeps 60 translucent bins (alpha has the fine resolution), while 90,000
    /// random translucent colours are folded to at most TRANS_MAX bins, and the result does not depend on how the
    /// samples were divided among threads (backlog P4).
    #[test]
    fn translucent_bins_keep_alpha_steps_and_fold_noise() {
        let mut h = Hist::new();
        for a in 1..=60u8 { for _ in 0..50 { h.push(u32::from_le_bytes([0, 0, 0, a * 4])); } h.end_row(); }
        let (_, trans, _, _) = h.into_points(&ColorSpace::new());
        assert_eq!(trans.len(), 60);
        assert!(trans.iter().all(|p| p.rgba[0] == 0.0 && (p.rgba[3] / 4.0).fract() == 0.0));

        let mut seed = 9u32;
        // `lcg` returns 24 bits, so the alpha needs a draw of its own (taking it from bits 24.. gave a constant 1,
        // 4096 cells at most, and the fold below never ran)
        let noise: Vec<u32> = (0..90_000).map(|_| { let rgb = lcg(&mut seed) & 0x00FF_FFFF; let a = 1 + lcg(&mut seed) % 254; rgb | (a << 24) }).collect();
        let feed = |chunks: usize| {
            let mut parts: Vec<Hist> = (0..chunks).map(|_| Hist::new()).collect();
            for (i, row) in noise.chunks(300).enumerate() { let h = &mut parts[i % chunks]; row.iter().for_each(|&k| h.push(k)); h.end_row(); }
            let mut h = parts.into_iter().reduce(Hist::merge).unwrap();
            assert!(h.ttouched.len() > TRANS_MAX, "{} translucent cells: the fold is not exercised", h.ttouched.len());
            h.translucent_bins()
        };
        let (one, eight) = (feed(1), feed(8));
        assert!(one.len() <= TRANS_MAX && one.len() > 256, "{} bins", one.len());
        assert_eq!(one, eight);
    }

    /// Two different 1-level colour pairs that straddle the same cell boundary are one point pair with the counts
    /// added (P44), and nothing is lost in the fold.
    #[test]
    fn neighbour_pairs_fold_to_one_record_per_point_pair() {
        let px = |r: u8, g: u8, b: u8| u32::from_le_bytes([r, g, b, 255]);
        let far = px(200, 200, 200);
        let mut h = Hist::new();
        // cells (2,2,2) and (3,2,2) of the 6-bit grid; each colour pair is seen twice, below the sample
        for (k, below) in [(px(11, 11, 11), px(12, 11, 11)), (px(11, 11, 10), px(12, 11, 10)), (px(11, 11, 11), px(12, 11, 11)), (px(11, 11, 10), px(12, 11, 10))] {
            h.push_w(k, crate::CTX_FP, 1, true, Some((below, far)));
            h.push_w(far, crate::CTX_FP, 1, false, None); h.end_row();
            h.push_w(below, crate::CTX_FP, 1, false, None); h.end_row();
        }
        let (opaque, _, _, raw) = h.into_points(&ColorSpace::new());
        assert_eq!(raw.len(), 4, "four colour pairs recorded, as recorded");
        let (pairs, total) = pairs_to_points(raw, &opaque);
        assert_eq!(pairs.len(), 1, "one point pair: {pairs:?}");
        assert_eq!(pairs[0].2, 4 * 8, "the counts of the folded records add up (8 per recorded pair, one in eight columns is sampled)");
        assert_eq!(total, 32.0, "the total counts every recorded pair");
        let (a, b) = (opaque[pairs[0].0 as usize].cell, opaque[pairs[0].1 as usize].cell);
        assert_eq!((a, b), (2 << 12 | 2 << 6 | 2, 3 << 12 | 2 << 6 | 2), "the two cells of the boundary");
    }

    #[test]
    fn flat_colours_survive_exactly_and_quality_is_reported() {
        // two big flat areas + a noisy gradient: the flat colours must come back bit-exact (snap step)
        let mut h = Hist::new();
        let mut seed = 1u32;
        for i in 0..200_000u32 {
            let k = match i % 4 {
                0 => u32::from_le_bytes([245, 245, 247, 255]),
                1 => u32::from_le_bytes([30, 31, 38, 255]),
                _ => u32::from_le_bytes([(i / 800) as u8, (lcg(&mut seed) % 256) as u8, (lcg(&mut seed) % 64) as u8, 255]),
            };
            h.push(k);
        }
        let q = quantize(&ColorSpace::new(), h, 0, 100, 2, &[]).ok().unwrap();
        assert!(q.palette.len() <= K_MAX && q.quality > 30);
        for want in [[245, 245, 247], [30, 31, 38]] {
            assert!(q.palette.iter().any(|c| [c.r, c.g, c.b] == want && c.a == 255), "{want:?} missing");
        }
    }
}
