//! Edge sub-palette (P34; docs/size-plan.md section 9, the variant the owner approved by eye: neighbour reach 2,
//! s = 0.2, every other neutral entry dropped).
//!
//! Anti-aliasing pixels of text sit between a dark and a bright side and take, in the full palette, whichever of the
//! many neutral entries is nearest; each such pixel is a literal for deflate and the alphabet of those literals is the
//! whole neutral axis (HANDOFF P32, phase 0-3). After the remap this pass gives those pixels a thinner ladder: the
//! neutral entries (max - min <= 8, not pinned or snapped, opaque) are sorted by luma and every other one is dropped
//! from the sub-palette S. A pixel written with a dropped entry moves to the closest entry of S whose luma is within
//! tau(C) = 0.5 s sqrt(255 C) of its own (C = contrast of the edge it sits on) and whose max - min does not exceed its
//! own by more than 4, when it is "modifiable": opaque, near-neutral (|r - g|, |b - g| <= 3), strictly between the two
//! pixels on each side along the row or the column (both sides looked at over two pixels; contrast >= 40 levels,
//! margin max(4, C / 10)), not next to a 1..2-level neighbour (a smooth pair that the banding guard protects), and,
//! for a run of identical pixels, every pixel of the run passes the vertical test. Everything else keeps the remap's
//! entry, so flat colours, gradients and colour content are untouched. A 32 x 32 window in which the changed pixels'
//! mean signed luma shift (Y_new - Y_base) / C exceeds 0.02 in magnitude is reverted (text must not get uniformly
//! bolder or lighter). Decisions depend only on the source pixels, the palette and S; the window sums are integers;
//! the output does not depend on the thread count.
//!
//! Measured in Python before the port (results/size-study-2026-09-20/subpal-own5-ladder2.txt, three of the owner's
//! screenshots): -3.0% bytes for RGB -1.0 and luma -2.0 dB, edge error p99 0.09 of the contrast, no change to false
//! contours, flat colours or colour casts; the owner compared the outputs with the originals and with `--quality
//! 70-78` at 100% and 200% and accepted them. `SHOTQ_SUBPAL=0` disables the pass (0.18.0 output).

use crate::color::{ColorSpace, Rgba};
use crate::quant;
use rayon::prelude::*;
use std::sync::atomic::{AtomicU16, Ordering};

/// Keep every K-th neutral entry of the ladder (K = 2: half of them).
pub const K: usize = 2;
/// Spacing of the ladder in edge-position units: tau(C) = 0.5 * S_STEP * sqrt(255 * C) luma levels.
const S_STEP: f64 = 0.2;
/// An edge must contrast by at least this many luma levels for its pixels to be modifiable.
const C0: i32 = 40;
/// Margin from both sides of the edge: max(D_MIN, D_FRAC * C).
const D_FRAC: f64 = 0.10;
const D_MIN: i32 = 4;
/// A palette entry is neutral (part of the ladder) when its channels differ by at most this.
const NEUTRAL_SPAN: i32 = 8;
/// The window bias check: windows of WIN x WIN pixels with at least WIN_MIN changed pixels whose mean signed shift
/// (Y_new - Y_base) / C exceeds BIAS_MAX are reverted.
const WIN: usize = 32;
const WIN_MIN: u32 = 32;
const BIAS_MAX: f64 = 0.02;
/// Contrast buckets for the lookup table; tau is taken at the lower edge of the bucket, so a pixel of any contrast in
/// the bucket satisfies the bound it was admitted under.
const BUCKET_LO: [i32; 6] = [40, 56, 80, 112, 160, 224];
const NB: usize = BUCKET_LO.len();
/// Luma in ten-thousandths of a level: exact integers, 0..=2_550_000.
const L10K: i32 = 10_000;
const NONE: u16 = 0xFFFE;
const EMPTY: u16 = 0xFFFF;

pub fn enabled() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| std::env::var("SHOTQ_SUBPAL").map_or(true, |s| s != "0"))
}

#[inline(always)] fn luma10k(r: u8, g: u8, b: u8) -> i32 { 2126 * r as i32 + 7152 * g as i32 + 722 * b as i32 }
#[inline(always)] fn px(rgba: &[u8], w: usize, x: usize, y: usize) -> [u8; 4] { let o = (y * w + x) * 4; [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]] }
#[inline(always)] fn luma_at(rgba: &[u8], w: usize, x: usize, y: usize) -> i32 { let p = px(rgba, w, x, y); luma10k(p[0], p[1], p[2]) }
/// Key of a near-neutral opaque colour in the (g, r - g, b - g) table, as `fine_index` in main.rs.
#[inline(always)] fn key(p: [u8; 4]) -> Option<usize> {
    let (dr, db) = (p[0] as i32 - p[1] as i32 + 3, p[2] as i32 - p[1] as i32 + 3);
    if p[3] == 255 && (dr as u32) < 7 && (db as u32) < 7 { Some(p[1] as usize * 49 + dr as usize * 7 + db as usize) } else { None }
}
#[inline(always)] fn bucket(c: i32) -> usize { let mut b = 0; while b + 1 < NB && c >= BUCKET_LO[b + 1] * L10K { b += 1; } b }

/// The "between two sides" test along one axis: lumas of the two pixels before (a1 nearest, a2 farther) and after.
/// Returns the edge contrast when the pixel lies strictly between the sides with the margin, else None.
#[inline(always)]
fn between(y: i32, a1: i32, a2: i32, b1: i32, b2: i32) -> Option<i32> {
    let (alo, ahi, blo, bhi) = (a1.min(a2), a1.max(a2), b1.min(b2), b1.max(b2));
    let (lo, hi) = (alo.min(blo), ahi.max(bhi));
    let c = hi - lo;
    if c < C0 * L10K { return None; }
    let d = (D_MIN * L10K).max((c as f64 * D_FRAC) as i32);
    let inside = lo + d <= y && y <= hi - d && ((ahi <= y && y <= blo) || (bhi <= y && y <= alo));
    inside.then_some(c)
}

/// A pixel next to a neighbour that differs by 1..2 levels in some channel belongs to a smooth pair: protected.
#[inline(always)]
fn near_smooth(rgba: &[u8], w: usize, h: usize, x: usize, y: usize) -> bool {
    let p = px(rgba, w, x, y);
    let close = |q: [u8; 4]| { let d = (0..4).map(|c| (p[c] as i32 - q[c] as i32).abs()).max().unwrap(); d >= 1 && d <= 2 };
    (x > 0 && close(px(rgba, w, x - 1, y))) || (x + 1 < w && close(px(rgba, w, x + 1, y))) || (y > 0 && close(px(rgba, w, x, y - 1))) || (y + 1 < h && close(px(rgba, w, x, y + 1)))
}

pub struct Report { pub kept: usize, pub dropped: usize, pub changed: usize, pub reverted: usize, pub windows: usize, pub split_runs: usize, pub partial_runs: usize }

/// SHOTQ_SUBPAL_RUN=1 (P38, experiment): a changed run that crosses a window boundary is kept or reverted as one
/// unit (reverted when any of its windows is flagged) instead of pixel by pixel, so no new transition can appear
/// inside it. Default off: the pixel-wise decision of 0.19.0.
fn run_unit() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| std::env::var("SHOTQ_SUBPAL_RUN").map_or(false, |s| s == "1"))
}

/// Applies the sub-palette to `raw` (filter-None rows of palette indices, as `remap` writes them) in place. `stats`
/// are the remap's per-entry statistics: an entry whose pixels are mostly in runs of identical pixels (flat content)
/// is a UI colour and stays in the ladder untouched; the pinned and snapped flat colours are such entries.
pub fn apply(w: usize, h: usize, rgba: &[u8], pal: &[Rgba], stats: &[[u64; 5]], space: &ColorSpace, raw: &mut [u8]) -> Report {
    let n = pal.len();
    let span: Vec<i32> = pal.iter().map(|c| c.r.max(c.g).max(c.b) as i32 - c.r.min(c.g).min(c.b) as i32).collect();
    let ylum: Vec<i32> = pal.iter().map(|c| luma10k(c.r, c.g, c.b)).collect();
    let flat_dom = |i: usize| stats.get(i).map_or(false, |s| s[0] > 0 && 2 * s[4] >= s[0]);
    // the ladder: neutral, opaque, not mostly-flat entries by luma (ties by index); every K-th is kept
    let mut ladder: Vec<usize> = (0..n).filter(|&i| pal[i].a == 255 && !flat_dom(i) && span[i] <= NEUTRAL_SPAN).collect();
    ladder.sort_by_key(|&i| (ylum[i], i));
    let mut in_s = vec![true; n];
    for (k, &i) in ladder.iter().enumerate() { if k % K != 0 { in_s[i] = false; } }
    let dropped = in_s.iter().filter(|&&s| !s).count();
    if dropped == 0 { return Report { kept: n, dropped: 0, changed: 0, reverted: 0, windows: 0, split_runs: 0, partial_runs: 0 }; }
    let pf = quant::Searcher::dist_only(space, pal);
    let tau: [i32; NB] = std::array::from_fn(|b| (0.5 * S_STEP * (255.0 * BUCKET_LO[b] as f64).sqrt() * L10K as f64) as i32);
    let table: Vec<AtomicU16> = (0..256 * 49 * NB).map(|_| AtomicU16::new(EMPTY)).collect();
    // closest admissible entry of S for a near-neutral colour and a contrast bucket. The first request for a colour
    // answers all six buckets in one pass over the entries (P38): the span test and the distance do not depend on
    // the bucket, only the luma window tau widens with it, so the per-bucket minima come from one set of distances
    let decide = |p: [u8; 4], k: usize, b: usize| -> u16 {
        let slot = &table[k * NB + b];
        let v = slot.load(Ordering::Relaxed);
        if v != EMPTY { return v; }
        let yp = luma10k(p[0], p[1], p[2]);
        let sp = p[0].max(p[1]).max(p[2]) as i32 - p[0].min(p[1]).min(p[2]) as i32;
        let c = space.conv(p[0], p[1], p[2], 255);
        let mut best = [(NONE, f32::MAX); NB];
        for i in 0..n {
            if !in_s[i] || pal[i].a != 255 || span[i] > sp + 4 { continue; }
            let dy = (ylum[i] - yp).abs();
            if dy > tau[NB - 1] { continue; }
            let d = pf.dist(&c, i);
            for (bb, bst) in best.iter_mut().enumerate() { if dy <= tau[bb] && (d < bst.1 || (d == bst.1 && (i as u16) < bst.0)) { *bst = (i as u16, d); } }
        }
        for (bb, bst) in best.iter().enumerate() { table[k * NB + bb].store(bst.0, Ordering::Relaxed); }
        best[b].0
    };
    let wcols = w.div_ceil(WIN);
    let stride = w + 1;
    let by_run = run_unit();
    // One band per row of WIN x WIN windows (P38): the window sums and the bias check are local to the band (plain
    // integers, no shared atomics, no serial revert pass), and the change list is kept per run so that a run
    // crossing a window boundary can be counted, and optionally judged, as one unit. Independent of the thread
    // count: the band is always WIN rows.
    let results: Vec<[usize; 5]> = raw.par_chunks_mut(stride * WIN).enumerate().map(|(bi, out)| {
        let mut list: Vec<(u32, u16, u8)> = Vec::new(); // (band-local offset of the first pixel, run length, old entry)
        let (mut win_n, mut win_s) = (vec![0u32; wcols], vec![0i64; wcols]);
        let y0 = bi * WIN;
        for (ry, row) in out.chunks_exact_mut(stride).enumerate() {
            let y = y0 + ry;
            let mut x = 0;
            while x < w {
                // only pixels written with a dropped entry are looked at; a run of identical source pixels shares
                // one entry (P33 keeps it whole), so the run is found while the entry stays the same
                let e = row[1 + x] as usize;
                if e >= n || in_s[e] { x += 1; continue; }
                let p = px(rgba, w, x, y);
                let k32 = u32::from_le_bytes(p);
                let mut x1 = x + 1;
                while x1 < w && row[1 + x1] as usize == e && u32::from_le_bytes(px(rgba, w, x1, y)) == k32 { x1 += 1; }
                {
                    if let Some(key) = key(p) {
                        // modifiable? a run needs every pixel to pass the vertical test; a single pixel either axis
                        let mut c: Option<i32> = None;
                        if y >= 2 && y + 2 < h {
                            let yp = luma10k(p[0], p[1], p[2]);
                            let vert = |xx: usize| between(yp, luma_at(rgba, w, xx, y - 1), luma_at(rgba, w, xx, y - 2), luma_at(rgba, w, xx, y + 1), luma_at(rgba, w, xx, y + 2));
                            if x1 - x >= 2 {
                                let mut cmin = i32::MAX; let mut all = true;
                                for xx in x..x1 { match vert(xx) { Some(cv) => cmin = cmin.min(cv), None => { all = false; break; } } }
                                if all { c = Some(cmin); }
                            } else {
                                let cv = vert(x);
                                let ch = if x >= 2 && x + 2 < w { between(yp, luma_at(rgba, w, x - 1, y), luma_at(rgba, w, x - 2, y), luma_at(rgba, w, x + 1, y), luma_at(rgba, w, x + 2, y)) } else { None };
                                c = match (ch, cv) { (Some(a), Some(b)) => Some(a.min(b)), (Some(a), None) => Some(a), (None, Some(b)) => Some(b), _ => None };
                            }
                        } else if x1 - x < 2 && x >= 2 && x + 2 < w {
                            let yp = luma10k(p[0], p[1], p[2]);
                            c = between(yp, luma_at(rgba, w, x - 1, y), luma_at(rgba, w, x - 2, y), luma_at(rgba, w, x + 1, y), luma_at(rgba, w, x + 2, y));
                        }
                        if let Some(cc) = c {
                            if !(x..x1).any(|xx| near_smooth(rgba, w, h, xx, y)) {
                                let ne = decide(p, key, bucket(cc));
                                if ne != NONE && ne as usize != e {
                                    let shift = ((ylum[ne as usize] - ylum[e]) as f64 / cc as f64 * 65536.0).round() as i64;
                                    for xx in x..x1 {
                                        row[1 + xx] = ne as u8;
                                        win_n[xx / WIN] += 1; win_s[xx / WIN] += shift;
                                    }
                                    list.push((((y - y0) * stride + 1 + x) as u32, (x1 - x) as u16, e as u8));
                                }
                            }
                        }
                    }
                }
                x = x1;
            }
        }
        // the bias check: revert windows where the changed pixels shifted the luma consistently in one direction
        let flagged: Vec<bool> = (0..wcols).map(|i| win_n[i] >= WIN_MIN && (win_s[i].unsigned_abs() as f64) > BIAS_MAX * 65536.0 * win_n[i] as f64).collect();
        let (mut changed, mut reverted, mut split, mut partial) = (0usize, 0usize, 0usize, 0usize);
        for &(pos, len, old) in &list {
            let (pos, len) = (pos as usize, len as usize);
            let x = pos % stride - 1;
            let (w0, w1) = (x / WIN, (x + len - 1) / WIN);
            if w0 != w1 { split += 1; }
            let any = (w0..=w1).any(|wc| flagged[wc]);
            if any && !(w0..=w1).all(|wc| flagged[wc]) { partial += 1; }
            if by_run {
                if any { out[pos..pos + len].fill(old); reverted += len; } else { changed += len; }
            } else {
                for i in 0..len { if flagged[(x + i) / WIN] { out[pos + i] = old; reverted += 1; } else { changed += 1; } }
            }
        }
        [flagged.iter().filter(|&&f| f).count(), changed, reverted, split, partial]
    }).collect();
    let sum = |i: usize| results.iter().map(|r| r[i]).sum::<usize>();
    Report { kept: n - dropped, dropped, changed: sum(1), reverted: sum(2), windows: sum(0), split_runs: sum(3), partial_runs: sum(4) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A grey palette in steps of 4, text-like edges with two-pixel fringes, a flat panel, a gradient and a 1-px line:
    /// only fringe pixels on dropped entries move, to a kept neutral entry within tau of their luma; the rest is
    /// untouched; the output does not depend on the thread count.
    #[test]
    fn only_edge_pixels_move_and_stay_within_the_ladder() {
        let (w, h) = (240usize, 48usize);
        let mut rgba = vec![0u8; w * h * 4];
        let set = |rgba: &mut Vec<u8>, x: usize, y: usize, g: u8| { let o = (y * w + x) * 4; rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255; };
        for y in 0..h { for x in 0..w {
            let g = if y < 16 {          // text: 4-px stems of 30 on 250 with 2-px fringes 116 / 180 (nearest entries 116 and 180 sit at odd ladder positions: dropped)
                match x % 12 { 0 | 1 => 250, 2 => 180, 3 => 116, 4..=7 => 30, 8 => 116, 9 => 180, _ => 250 }
            } else if y < 24 { 200 }     // flat panel
            else if y < 32 { (x * 255 / w) as u8 }   // gradient: smooth pairs, protected
            else if y < 40 { if x % 20 == 10 { 90 } else { 250 } }   // 1-px dark line: an extreme, not between
            else { 250 };
            set(&mut rgba, x, y, g);
        } }
        let pal: Vec<Rgba> = (0..64).map(|k| { let g = (k * 4) as u8; Rgba { r: g, g, b: g, a: 255 } }).collect();
        // statistics as the remap would report them: the panel (200) and the near-white (248) are flat content
        let stats: Vec<[u64; 5]> = pal.iter().map(|c| if c.g == 200 || c.g == 248 { [1000, 0, 0, 0, 1000] } else { [10, 0, 0, 0, 0] }).collect();
        let locked: Vec<bool> = pal.iter().map(|c| c.g == 200 || c.g == 248).collect();
        let space = ColorSpace::new();
        // the base remap: nearest grey entry
        let mut raw = vec![0u8; (w + 1) * h];
        for y in 0..h { for x in 0..w { raw[y * (w + 1) + 1 + x] = ((rgba[(y * w + x) * 4] as usize + 2) / 4).min(63) as u8; } }
        let base = raw.clone();
        let rep = apply(w, h, &rgba, &pal, &stats, &space, &mut raw);
        assert!(rep.dropped > 0 && rep.changed > 0, "dropped {} changed {}", rep.dropped, rep.changed);
        let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
        let mut raw1 = base.clone();
        pool.install(|| apply(w, h, &rgba, &pal, &stats, &space, &mut raw1));
        assert_eq!(raw, raw1, "thread count changed the output");
        // which entries survived
        let ladder: Vec<usize> = (0..64).filter(|&i| !locked[i]).collect();
        let kept: Vec<bool> = (0..64).map(|i| ladder.iter().position(|&j| j == i).map_or(true, |k| k % K == 0)).collect();
        for y in 0..h { for x in 0..w {
            let (a, b) = (base[y * (w + 1) + 1 + x] as usize, raw[y * (w + 1) + 1 + x] as usize);
            if a == b { continue; }
            assert!(y < 16, "a pixel outside the text rows moved ({x},{y})");
            let g = rgba[(y * w + x) * 4];
            assert!(g == 116 || g == 180, "a non-fringe pixel moved ({x},{y}) value {g}");
            assert!(!kept[a] && kept[b], "moved from a kept entry or to a dropped one: {a} -> {b}");
            let tau = 0.5 * S_STEP * (255.0f64 * 220.0).sqrt();   // the fringe contrast is 250 - 30 = 220
            assert!((pal[b].g as f64 - g as f64).abs() <= tau + 1e-9, "moved beyond tau: {g} -> {}", pal[b].g);
        } }
        assert!((16..h).all(|y| (0..w).all(|x| base[y * (w + 1) + 1 + x] == raw[y * (w + 1) + 1 + x])));
    }
}
