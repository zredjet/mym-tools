//! shotq — time-first lossy PNG optimizer for screenshots.
//!
//! Pipeline (every stage runs exactly once; all decisions are made before the single deflate call):
//!   1. load      PNG (own reader: one libdeflate inflate + wavefront-parallel unfiltering; png crate for the
//!                rest) or uncompressed BMP (no inflate/unfilter cost at all)
//!   2. lossless? <=256 unique colours -> exact palette, quantizer skipped
//!   3. quantize  own palette builder (quant.rs) on a jittered ~1 MP sample: Wu splitting + pruned weighted k-means
//!   4. remap     own remapper: run reuse + 18-bit colour-cell LUT, parallel over row bands
//!   5. encode    indexed PNG, filter None, deflate in 64-256 KB chunks in parallel (one zlib stream)
//!
//! The library entry point is `optimize` (bytes in, bytes out, no file access); `src/main.rs` is the CLI around it.
//! `Status` keeps pngquant's exit codes: 0 ok, 99 quality below --quality min (image kept lossless),
//! 98 result was not smaller (original kept); the CLI adds 2 usage, 1 other errors.
//!
//! Set SHOTQ_DEBUG=1 to print the timing of the phases inside the palette builder.

mod cm;
mod color;
mod deflate;
mod quant;
mod subpal;

use color::{ColorSpace, Rgba};
use rayon::prelude::*;
use std::sync::atomic::{AtomicU16, AtomicU64, AtomicUsize, Ordering};
use std::time::Instant;

// ---------------------------------------------------------------- options

/// The encoder settings of one run. `Options::default()` is the CLI without flags: `--quality 70-85 --speed 10`.
#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    /// `--quality MIN-MAX` on shotq's 0-100 scale; `qmin <= qmax <= 100`
    pub qmin: u8,
    pub qmax: u8,
    /// `--speed 1-11`: k-means iterations 11 -> 1, 8-10 -> 2, 5-7 -> 4, 3-4 -> 8, 1-2 -> 16
    pub speed: i32,
    /// `--level 1-9`, None = auto
    pub level: Option<i32>,
    /// `--sample N`, 0 = auto
    pub sample: usize,
    /// `--floyd` strength 0..1, 0 = off
    pub dither: f32,
    /// `--quantizer liq` (only in builds with the `liq` feature)
    pub use_liq: bool,
}

impl Default for Options {
    fn default() -> Self { Options { qmin: 70, qmax: 85, speed: 10, level: None, sample: 0, dither: 0.0, use_liq: false } }
}

// ---------------------------------------------------------------- loading

struct Image {
    w: usize,
    h: usize,
    rgba: Vec<u8>,
    is_png: bool,
    depth16: bool, // a 16-bit PNG, already reduced to 8 bits here: even the <=256-colour path is then not lossless
    colour: cm::Colour, // the input's colour tag (iCCP / sRGB / gAMA+cHRM, or the BMP V5 colour space): decides the output's tag and palette conversion
}

fn load(data: &[u8]) -> Result<Image, String> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        // Both readers decode the same pixels. The own one wins from two threads up (5K: 15 ms on 16 threads vs 49);
        // on one thread its unfiltering is 12% slower than the png crate's, so that one stays with the crate.
        if rayon::current_num_threads() <= 1 { load_png(data) } else { load_png_fast(data).map(Ok).unwrap_or_else(|| load_png(data)) }
    } else if data.starts_with(b"BM") {
        load_bmp(data)
    } else {
        Err("input is neither PNG nor BMP".into())
    }
}

/// Own reader for the common screenshot case: 8-bit, not interlaced, colour type 0/2/3/4/6. All IDAT data is
/// inflated in one libdeflate call (8 ms for a 5K RGBA screenshot; the pure Rust inflaters take 12-13), then the
/// filters are undone straight into the RGBA buffer by up to 16 threads in a wavefront: each thread owns a vertical
/// strip and does row y once the strip to its left has finished row y (Sub/Average/Paeth need the pixel to the
/// left, Up/Average/Paeth the row above). Unfiltering used to be 2/3 of the decode time (32 of 45 ms at 5K) and
/// cannot be split by rows. Anything unusual (16-bit, interlaced, a transparent colour on a greyscale or RGB
/// image) or doubtful (a wrong chunk CRC, a missing IEND, an unknown critical chunk, an APNG `acTL` chunk, a
/// compression or filter method other than 0, dimensions over MAX_PIXELS or beyond what the IDAT bytes could
/// inflate to, chunks out of order or malformed: IHDR not first, PLTE or tRNS twice, after the image data or with
/// a bad length, IDAT chunks interrupted by another chunk) returns None and goes through the png crate, which
/// decodes the unusual and rejects the doubtful with its own error message. So a file is accepted or refused the
/// same way whatever the thread count (P37: the unit test feeds mutated files to both readers).
fn load_png_fast(data: &[u8]) -> Option<Image> {
    let dbg = std::env::var_os("SHOTQ_DEBUG").is_some();
    let t = Instant::now();
    let be32 = |b: &[u8]| u32::from_be_bytes(b.try_into().unwrap()) as usize;
    let (mut w, mut h, mut depth, mut ct, mut interlace, mut ihdr) = (0usize, 0usize, 0u8, 0u8, 0u8, false);
    let (mut plte, mut trns): (&[u8], &[u8]) = (&[], &[]);
    // colour chunks: a duplicate, or one after the first IDAT, is refused by the png crate, so it goes there
    let (mut iccp, mut srgb, mut gama, mut chrm, mut seen_idat) = (None::<&[u8]>, None::<u8>, None::<u32>, None::<[u32; 8]>, false);
    // chunk order and shape the png crate refuses (P37): IHDR must come first, PLTE and tRNS once and before the
    // image data (tRNS after PLTE on an indexed image), the IDAT chunks consecutive
    let (mut idat_done, mut seen_plte, mut seen_trns) = (false, false, false);
    // The chunk headers are walked once before the scan to size the buffers: the owner's screenshots come as
    // 165-236 IDAT chunks of 16 KB, the 5K photo as 656 of 64 KB, and growing the buffer as they came copied about
    // twice the data (2 ms on the photo, P44). A truncated chunk ends the walk; the scan below refuses it.
    let (mut idat_len, mut n_chunks, mut q) = (0usize, 0usize, 8usize);
    while q + 8 <= data.len() {
        let n = be32(&data[q..q + 4]);
        if data.len() - q - 8 < n { break; }
        n_chunks += 1;
        match &data[q + 4..q + 8] { b"IDAT" => idat_len += n, b"IEND" => break, _ => {} }
        q += 12 + n;
    }
    let mut crcs: Vec<(usize, usize, u32)> = Vec::with_capacity(n_chunks); // per chunk: start of the type field, its length + the body's, stored CRC
    let mut idat: Vec<u8> = Vec::with_capacity(idat_len);
    // the copy's cost is the first touch of the fresh pages (2.3 ms for the 42 MB photo), not the memcpy
    #[cfg(unix)]
    if idat_len >= 1 << 20 { unsafe { libc::madvise(idat.as_mut_ptr() as *mut libc::c_void, idat_len, libc::MADV_WILLNEED); } }
    let mut iend = false;
    let mut pos = 8;
    while pos + 8 <= data.len() {
        let n = be32(&data[pos..pos + 4]);
        let ty = &data[pos + 4..pos + 8];
        let body = data.get(pos + 8..pos + 8 + n)?;
        crcs.push((pos + 4, n + 4, be32(data.get(pos + 8 + n..pos + 12 + n)?) as u32));
        if !ihdr && ty != b"IHDR" { return None; }
        if seen_idat && ty != b"IDAT" { idat_done = true; }
        match ty {
            b"IHDR" => {
                if n != 13 || ihdr || body[10] != 0 || body[11] != 0 { return None; } // one IHDR; compression and filter method 0
                w = be32(&body[0..4]); h = be32(&body[4..8]); depth = body[8]; ct = body[9]; interlace = body[12]; ihdr = true;
            }
            b"PLTE" => { if seen_plte || seen_idat || seen_trns || n == 0 || n % 3 != 0 || n > 768 || matches!(ct, 0 | 4) { return None; } seen_plte = true; plte = body }
            b"tRNS" => { if seen_trns || seen_idat || (ct == 3 && (!seen_plte || n > plte.len() / 3)) { return None; } seen_trns = true; trns = body }
            b"IDAT" => { if idat_done { return None; } seen_idat = true; idat.extend_from_slice(body) }
            b"iCCP" => { if iccp.is_some() || seen_idat { return None; } iccp = Some(body) }
            b"sRGB" => { if srgb.is_some() || seen_idat || n != 1 || body[0] > 3 { return None; } srgb = Some(body[0]) }
            b"gAMA" => { if gama.is_some() || seen_idat || n != 4 || be32(body) == 0 { return None; } gama = Some(be32(body) as u32) } // 0 is an error in the crate
            b"cHRM" => { if chrm.is_some() || seen_idat || n != 32 { return None; } let mut c = [0u32; 8]; for (i, v) in body.chunks_exact(4).enumerate() { c[i] = be32(v) as u32; } chrm = Some(c) }
            b"IEND" => { iend = true; break }
            b"acTL" => return None, // APNG: `load_png` refuses it with a message
            _ if ty[0] & 0x20 == 0 => return None, // an unknown critical chunk
            _ => {}
        }
        pos += 12 + n;
    }
    if !ihdr || !iend || depth != 8 || interlace != 0 || w == 0 || h == 0 { return None; }
    // tRNS on a greyscale or RGB image makes one colour transparent; the png crate expands that into alpha.
    if matches!(ct, 0 | 2) && !trns.is_empty() { return None; }
    let bpp = match ct { 0 => 1, 2 => 3, 3 if !plte.is_empty() => 1, 4 => 2, 6 => 4, _ => return None };
    let stride = w.checked_mul(bpp)?.checked_add(1)?;
    let raw_len = stride.checked_mul(h)?;
    // Both sizes are settled before anything is allocated: a header alone must not make shotq map gigabytes. A
    // deflate stream inflates to at most 1032x its length, so an IDAT too short for the claimed size is no image.
    if w.checked_mul(h)? > MAX_PIXELS || raw_len > idat.len().saturating_mul(1032) { return None; }
    let t_parse = t.elapsed();
    let mut raw = vec![0u8; raw_len];
    let mut rgba = vec![0u8; w * h * 4];
    // Fresh memory costs ~0.9 us per 16 KB page on first touch (3.4 ms per 60 MB), and touching one buffer from
    // several threads contends instead of scaling. madvise(WILLNEED) makes the kernel map the pages in one go
    // (1.5 ms per 60 MB). The inflate buffer is mapped first; the output buffer is mapped while the inflate runs.
    prefault(&mut raw);
    let t_fault = t.elapsed();
    // The chunk CRCs are verified next to the inflate: 0.1-0.5 ms for a screenshot on one core (17-29 GB/s on the
    // M4), hidden behind the 8 ms inflate.
    let (n, crc_ok) = rayon::join(
        || libdeflater::Decompressor::new().zlib_decompress(&idat, &mut raw).ok(),
        || { prefault(&mut rgba); crcs.iter().all(|&(at, len, want)| crc32fast::hash(&data[at..at + len]) == want) });
    let t_inflate = t.elapsed();
    if !crc_ok || n? != raw.len() || raw.chunks_exact(stride).any(|r| r[0] > 4) { return None; }
    if dbg { eprintln!("  png: parse+copy {:?}, prefault {:?}, inflate + crc {:?}", t_parse, t_fault - t_parse, t_inflate - t_fault); }
    let mut pal = [Rgba { r: 0, g: 0, b: 0, a: 255 }; 256];
    for (i, c) in plte.chunks_exact(3).take(256).enumerate() { pal[i] = Rgba { r: c[0], g: c[1], b: c[2], a: trns.get(i).copied().unwrap_or(255) }; }
    let (workers, strips, tasks) = unfilter_wavefront(&mut raw, w, h, bpp, ct, &pal, &mut rgba);
    if dbg { eprintln!("  png: wavefront unfilter + expand {:?} ({workers} workers, {strips} strips, {tasks} tasks)", t.elapsed() - t_inflate); }
    // the same precedence as `colour_of` derives from the png crate's info; an iCCP the crate ignores counts as absent
    let colour = colour_of(iccp.and_then(cm::Colour::from_iccp), srgb.is_some(), gama.map(|g| g as f32 / 1e5), chrm.map(|c| c.map(|v| v as f32 / 1e5)), matches!(ct, 0 | 4));
    Some(Image { w, h, rgba, is_png: true, depth16: false, colour })
}

/// Largest image either reader accepts: 2^28 pixels (16384 x 16384, 1 GiB of RGBA). Screenshots are far below;
/// a forged header must not make shotq map tens of gigabytes (a 950-byte file claiming 65535 x 65535 cost 30 GB).
const MAX_PIXELS: usize = 1 << 28;

/// The input's colour tag from what a PNG reader found: iCCP over sRGB over gAMA (+ cHRM), as the specification orders
/// them. A GRAY profile belongs to a greyscale image (`grey`: colour type 0 or 4); on colour data it is invalid and
/// ignored, as ColorSync does.
fn colour_of(icc: Option<Vec<u8>>, srgb: bool, gamma: Option<f32>, chrm: Option<[f32; 8]>, grey: bool) -> cm::Colour {
    match (icc, srgb, gamma) {
        (Some(p), _, _) if cm::is_gray_profile(&p) => if grey { cm::Colour::GrayProfile(p) } else { colour_of(None, srgb, gamma, chrm, grey) },
        (Some(p), _, _) => cm::Colour::Profile(p),
        (None, true, _) => cm::Colour::Srgb,
        (None, false, Some(g)) => cm::Colour::from_gamma(g, chrm),
        (None, false, None) => cm::Colour::None,
    }
}

/// Asks the kernel to map a buffer's pages now; the first write to each page would otherwise take a fault.
fn prefault(buf: &mut [u8]) {
    #[cfg(unix)]
    unsafe { libc::madvise(buf.as_mut_ptr() as *mut libc::c_void, buf.len(), libc::MADV_WILLNEED); }
    #[cfg(not(unix))]
    for p in buf.iter_mut().step_by(4096) { unsafe { std::ptr::write_volatile(p, 0) } }
}

struct SendPtr<T>(*mut T);
unsafe impl<T> Send for SendPtr<T> {}
unsafe impl<T> Sync for SendPtr<T> {}
impl<T> SendPtr<T> { fn get(&self) -> *mut T { self.0 } } // a method, so that closures capture the wrapper, not the raw field

/// One strip's progress counter on a cache line of its own: 16 adjacent counters in one 128-byte line made every
/// hand-off invalidate every strip's spin loop (measured: the unfiltering stopped scaling beyond 6x).
#[repr(align(128))]
struct Progress(AtomicUsize);

/// Rows per wavefront task. One atomic hand-off per row cost ~3 us of cache-line traffic per row on the M4 (2880
/// rows: 8 ms, more than the unfiltering itself); per 16 rows it is noise.
const WAVEFRONT_ROWS: usize = 16;

/// Number of performance cores (macOS: `hw.perflevel0.logicalcpu`), None where unknown. The wavefront below is a
/// chain of dependent tasks: a thread on an efficiency core finishes its task at half speed and everything behind it
/// waits, so it runs on the performance cores only (5K desktop: 4.3 ms on 12 threads, 7.2 ms on all 16).
#[cfg(target_os = "macos")]
fn performance_cores() -> Option<usize> {
    let (mut v, mut len) = (0u32, std::mem::size_of::<u32>());
    let rc = unsafe { libc::sysctlbyname(c"hw.perflevel0.logicalcpu".as_ptr(), &mut v as *mut u32 as *mut libc::c_void, &mut len, std::ptr::null_mut(), 0) };
    (rc == 0 && v > 0).then_some(v as usize)
}
#[cfg(not(target_os = "macos"))]
fn performance_cores() -> Option<usize> { None }

/// Undoes the PNG row filters of `raw` (filter byte + `bpp` bytes per pixel per row) and writes RGBA into `rgba`.
/// The image is cut into vertical strips and groups of WAVEFRONT_ROWS rows; task (s, g) needs (s-1, g) for the
/// pixels left of the strip and (s, g-1) for the row above. Tasks are claimed in diagonal order (s + g), so every
/// dependency of a task was claimed earlier by a thread that is running it: the waits are short and cannot
/// deadlock, and a slow thread simply claims fewer tasks. 1.5 strips per worker keeps everyone busy without making
/// the diagonals longer than the workers (2 strips per worker: half the threads waited). RGBA input is unfiltered
/// straight into `rgba` (same layout); the other colour types are unfiltered in place in `raw`, then expanded.
/// Returns (workers, strips, tasks).
fn unfilter_wavefront(raw: &mut [u8], w: usize, h: usize, bpp: usize, ct: u8, pal: &[Rgba; 256], rgba: &mut [u8]) -> (usize, usize, usize) {
    let workers = rayon::current_num_threads().max(1).min(performance_cores().unwrap_or(usize::MAX));
    let strips = if workers == 1 { 1 } else { (workers * 3 / 2).clamp(1, 32) }.min(w);
    let groups = h.div_ceil(WAVEFRONT_ROWS);
    let stride = w * bpp + 1;
    let mut order: Vec<(u16, u32)> = Vec::with_capacity(strips * groups);
    for d in 0..strips + groups - 1 { for s in 0..strips.min(d + 1) { if d - s < groups { order.push((s as u16, (d - s) as u32)); } } }
    let next = AtomicUsize::new(0);
    let done: Vec<Progress> = (0..strips).map(|_| Progress(AtomicUsize::new(0))).collect();
    let zeros = vec![0u8; w.div_ceil(strips) * 4 + 8];
    let (rp, op) = (SendPtr(raw.as_mut_ptr()), SendPtr(rgba.as_mut_ptr()));
    let worker = || { let maxn = w.div_ceil(strips) * bpp + bpp; let (mut tmp, mut cur_buf, mut prev_buf) = (vec![0u8; maxn], vec![0u8; maxn], vec![0u8; maxn]); loop {
        let k = next.fetch_add(1, Ordering::Relaxed);
        let Some(&(s, g)) = order.get(k) else { break };
        let (s, g) = (s as usize, g as usize);
        if g > 0 { while done[s].0.load(Ordering::Acquire) < g { std::hint::spin_loop(); } }
        if s > 0 { while done[s - 1].0.load(Ordering::Acquire) <= g { std::hint::spin_loop(); } }
        let (x0, x1) = (s * w / strips, (s + 1) * w / strips);
        let n = (x1 - x0) * bpp;
        for y in g * WAVEFRONT_ROWS..((g + 1) * WAVEFRONT_ROWS).min(h) {
            // SAFETY: this task is the only writer of columns x0..x1 of the rows of group g, in `raw` (in-place path)
            // and in `rgba`. The bytes it reads outside that range (pixel x0-1 of rows y and y-1, row y-1 of its own
            // columns, the filter byte) were written by tasks that finished before the Acquire loads above, or are
            // never written. Both buffers outlive the scope.
            let filter = unsafe { *rp.get().add(y * stride) };
            let dst = unsafe { std::slice::from_raw_parts_mut(op.get().add((y * w + x0) * 4), (x1 - x0) * 4) };
            if ct == 6 {
                // Unfiltered into a small per-worker row buffer (L1) and copied out; the row above is taken from the
                // buffer of the previous row within the task and from `rgba` at the task's first row. Reading the
                // row above from `rgba` for every row cost 1.4x on one thread.
                let src = unsafe { std::slice::from_raw_parts(rp.get().add(y * stride + 1 + x0 * 4), n) };
                let at = |yy: usize, x: usize, len: usize| unsafe { std::slice::from_raw_parts(op.get().add((yy * w + x) * 4), len) };
                let left = if s > 0 { at(y, x0 - 1, 4) } else { &zeros[..4] };
                let prev: &[u8] = if y == 0 { &zeros[..n] } else if y == g * WAVEFRONT_ROWS { at(y - 1, x0, n) } else { &prev_buf[..n] };
                let prev_left = if s > 0 && y > 0 { at(y - 1, x0 - 1, 4) } else { &zeros[..4] };
                unfilter_row::<4>(filter, src, &mut cur_buf[..n], left, prev, prev_left);
                dst.copy_from_slice(&cur_buf[..n]);
                std::mem::swap(&mut cur_buf, &mut prev_buf);
            } else { // in place: the filtered bytes of this row segment are copied aside first (cheap, L1-resident)
                let cur = unsafe { std::slice::from_raw_parts_mut(rp.get().add(y * stride + 1 + x0 * bpp), n) };
                let at = |yy: usize, x: usize, len: usize| unsafe { std::slice::from_raw_parts(rp.get().add(yy * stride + 1 + x * bpp), len) };
                let left = if s > 0 { at(y, x0 - 1, bpp) } else { &zeros[..bpp] };
                let prev = if y > 0 { at(y - 1, x0, n) } else { &zeros[..n] };
                let prev_left = if s > 0 && y > 0 { at(y - 1, x0 - 1, bpp) } else { &zeros[..bpp] };
                let src = &mut tmp[..n];
                src.copy_from_slice(cur);
                match bpp {
                    1 => unfilter_row::<1>(filter, src, cur, left, prev, prev_left),
                    2 => unfilter_row::<2>(filter, src, cur, left, prev, prev_left),
                    _ => unfilter_row::<3>(filter, src, cur, left, prev, prev_left),
                }
                match ct {
                    2 => for (d, s) in dst.chunks_exact_mut(4).zip(cur.chunks_exact(3)) { d.copy_from_slice(&[s[0], s[1], s[2], 255]); },
                    0 => for (d, &g) in dst.chunks_exact_mut(4).zip(cur.iter()) { d.copy_from_slice(&[g, g, g, 255]); },
                    4 => for (d, s) in dst.chunks_exact_mut(4).zip(cur.chunks_exact(2)) { d.copy_from_slice(&[s[0], s[0], s[0], s[1]]); },
                    _ => for (d, &i) in dst.chunks_exact_mut(4).zip(cur.iter()) { let c = pal[i as usize]; d.copy_from_slice(&[c.r, c.g, c.b, c.a]); },
                }
            }
        }
        done[s].0.store(g + 1, Ordering::Release);
    } };
    if workers == 1 { worker(); } else { rayon::scope(|sc| for _ in 0..workers { sc.spawn(|_| worker()); }); }
    (workers, strips, order.len())
}

/// Undoes one row filter for one strip: filtered bytes in `src`, unfiltered bytes to `dst`. `left` is the unfiltered
/// pixel left of the strip, `prev` the unfiltered row above (same columns), `prev_left` the pixel above-left; zero
/// bytes stand in at the image border, as the PNG spec prescribes. Written per pixel with the BPP channels as
/// independent lanes: the dependency on the pixel to the left makes a row serial, the lanes are what the compiler
/// can vectorise. The filter dispatch stays outside the pixel loop (inside, it cost 1.6x). Measured alternatives for
/// the Paeth rows, all slower on the M4: NEON lanes (one 2-cycle chain instead of four 1-cycle ones, 7 ns per
/// pixel vs 4.9), hand-unrolled scalar lanes with i32 (6 ns), element-wise array steps (10 ns).
#[inline(always)]
fn unfilter_row<const BPP: usize>(filter: u8, src: &[u8], dst: &mut [u8], left: &[u8], prev: &[u8], prev_left: &[u8]) {
    let mut a = [0u8; BPP];
    a.copy_from_slice(&left[..BPP]);
    match filter {
        0 => dst.copy_from_slice(src),
        1 => for (o, s) in dst.chunks_exact_mut(BPP).zip(src.chunks_exact(BPP)) {
            for k in 0..BPP { a[k] = s[k].wrapping_add(a[k]); }
            o.copy_from_slice(&a);
        },
        2 => for ((o, s), b) in dst.chunks_exact_mut(BPP).zip(src.chunks_exact(BPP)).zip(prev.chunks_exact(BPP)) {
            for k in 0..BPP { o[k] = s[k].wrapping_add(b[k]); }
        },
        3 => for ((o, s), b) in dst.chunks_exact_mut(BPP).zip(src.chunks_exact(BPP)).zip(prev.chunks_exact(BPP)) {
            for k in 0..BPP { a[k] = s[k].wrapping_add(((a[k] as u16 + b[k] as u16) >> 1) as u8); }
            o.copy_from_slice(&a);
        },
        _ => {
            let mut c = [0u8; BPP];
            c.copy_from_slice(&prev_left[..BPP]);
            let n = dst.len();
            let mut i = 0;
            while i < n {
                // A stretch of zero filter bytes that starts where the left pixel equals the pixel above-left decodes
                // to the row above (P38): with a == c the predictor is b, so the output is b, and then a == c holds
                // for the next pixel too. Screenshots are full of such stretches (32% of the owner's pixels in 64-px
                // windows): they are copied, 8 zero bytes at a time, instead of predicted pixel by pixel.
                if a == c {
                    let mut j = i;
                    while j + 8 <= n && src[j..j + 8] == [0u8; 8] { j += 8; }
                    j -= (j - i) % BPP;
                    if j > i {
                        dst[i..j].copy_from_slice(&prev[i..j]);
                        a.copy_from_slice(&prev[j - BPP..j]);
                        c.copy_from_slice(&prev[j - BPP..j]);
                        i = j;
                        if i >= n { break; }
                    }
                }
                let (s, b) = (&src[i..i + BPP], &prev[i..i + BPP]);
                for k in 0..BPP {
                    let (pa, pb, pc) = (a[k] as i16, b[k] as i16, c[k] as i16);
                    let p = pa + pb - pc;
                    let (da, db, dc) = ((p - pa).abs(), (p - pb).abs(), (p - pc).abs());
                    let pred = if da <= db && da <= dc { pa } else if db <= dc { pb } else { pc };
                    a[k] = s[k].wrapping_add(pred as u8);
                }
                dst[i..i + BPP].copy_from_slice(&a);
                c.copy_from_slice(b);
                i += BPP;
            }
        }
    }
}

/// General PNG reader (16-bit, interlaced, low bit depths, tRNS colours): the png crate, which also checks the
/// chunk CRCs and structure and so gives the error message for anything the own reader refused as doubtful.
/// APNG is refused here: both readers would otherwise turn the animation into its first frame.
fn load_png(data: &[u8]) -> Result<Image, String> {
    // png 0.18.1 panics (instead of erroring) while expanding a palette whose PLTE length is not a multiple of 3:
    // refuse such a file here, so that both thread counts fail with the same message (P37)
    let mut pos = 8;
    while pos + 8 <= data.len() {
        let n = u32::from_be_bytes(data[pos..pos + 4].try_into().unwrap()) as usize;
        if &data[pos + 4..pos + 8] == b"PLTE" && (n == 0 || n % 3 != 0 || n > 768) { return Err(format!("malformed PLTE chunk ({n} bytes)")); }
        pos += 12 + n;
    }
    let mut dec = png::Decoder::new(std::io::Cursor::new(data));
    dec.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = dec.read_info().map_err(|e| e.to_string())?;
    let (iw, ih, animated) = (reader.info().width as usize, reader.info().height as usize, reader.info().animation_control.is_some());
    if animated { return Err("animated PNG (APNG) is not supported".into()); }
    if iw.checked_mul(ih).map_or(true, |n| n > MAX_PIXELS) { return Err(format!("image too large: {iw}x{ih} (the limit is {MAX_PIXELS} pixels)")); }
    let depth16 = reader.info().bit_depth == png::BitDepth::Sixteen;
    let info = reader.info();
    let chrm = info.chrm_chunk.map(|c| [c.white.0, c.white.1, c.red.0, c.red.1, c.green.0, c.green.1, c.blue.0, c.blue.1].map(|v| v.into_value()));
    let grey = matches!(info.color_type, png::ColorType::Grayscale | png::ColorType::GrayscaleAlpha);
    let colour = colour_of(info.icc_profile.as_ref().map(|p| p.to_vec()), info.srgb.is_some(), info.gama_chunk.map(|g| g.into_value()), chrm, grey);
    let size = reader.output_buffer_size().ok_or("image too large")?;
    let mut buf = vec![0u8; size];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let (w, h) = (info.width as usize, info.height as usize);
    buf.truncate(info.buffer_size());
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => expand(&buf, w * h, 3, |s, d| d.copy_from_slice(&[s[0], s[1], s[2], 255])),
        png::ColorType::Grayscale => expand(&buf, w * h, 1, |s, d| d.copy_from_slice(&[s[0], s[0], s[0], 255])),
        png::ColorType::GrayscaleAlpha => expand(&buf, w * h, 2, |s, d| d.copy_from_slice(&[s[0], s[0], s[0], s[1]])),
        png::ColorType::Indexed => return Err("unexpected indexed output from decoder".into()),
    };
    Ok(Image { w, h, rgba, is_png: true, depth16, colour })
}

fn expand(src: &[u8], npx: usize, bpp: usize, f: impl Fn(&[u8], &mut [u8]) + Sync) -> Vec<u8> {
    let mut out = vec![0u8; npx * 4];
    out.par_chunks_mut(4 << 16).zip(src.par_chunks(bpp << 16)).for_each(|(d, s)| {
        for (d, s) in d.chunks_exact_mut(4).zip(s.chunks_exact(bpp)) { f(s, d) }
    });
    out
}

/// Minimal BMP reader: uncompressed 24/32 bpp, bottom-up or top-down — what screenshot tools emit. Alpha is
/// decided by the header, as the format defines it: only a BI_BITFIELDS file with a non-zero alpha mask (BITMAPV3
/// header or later) carries alpha; in a 32-bit BI_RGB file and a three-mask BITFIELDS file the fourth byte is unused
/// and every pixel is opaque, whatever the byte holds. macOS ImageIO (`sips`, and so `screencapture -t bmp`) writes
/// RGBA as a V5 header with an alpha mask and opaque images as 24-bit BI_RGB. Colour: a V5 header names the
/// colour space; ImageIO converts the pixels to sRGB and says LCS_sRGB (measured against `screencapture -t png`
/// of the same screen), so the output is tagged sRGB at no cost. An embedded profile (PROFILE_EMBEDDED) is read
/// like an iCCP; older headers, calibrated or linked colour spaces count as untagged.
fn load_bmp(d: &[u8]) -> Result<Image, String> {
    let u32at = |o: usize| d.get(o..o + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap())).ok_or("truncated BMP");
    let u16at = |o: usize| d.get(o..o + 2).map(|b| u16::from_le_bytes(b.try_into().unwrap())).ok_or("truncated BMP");
    let off = u32at(10)? as usize;
    let hdr = u32at(14)? as usize;
    if hdr < 40 { return Err("unsupported BMP header".into()); }
    let w = u32at(18)? as i32;
    let hh = u32at(22)? as i32;
    let bpp = u16at(28)? as usize;
    let comp = u32at(30)?;
    if w <= 0 || hh == 0 || !(bpp == 24 || bpp == 32) || !(comp == 0 || comp == 3) {
        return Err(format!("unsupported BMP (bpp={bpp}, compression={comp}); use PNG input instead"));
    }
    let (w, h, top_down) = (w as usize, hh.unsigned_abs() as usize, hh < 0);
    if w.checked_mul(h).map_or(true, |n| n > MAX_PIXELS) { return Err(format!("image too large: {w}x{h} (the limit is {MAX_PIXELS} pixels)")); }
    // byte position of r, g, b inside a pixel (default BGR) and of alpha, if the header declares one: byte-aligned
    // BI_BITFIELDS masks; the alpha mask exists from the 56-byte BITMAPV3INFOHEADER on
    let mut pos = [2usize, 1, 0];
    let mut alpha: Option<usize> = None;
    if comp == 3 {
        let byte = |m: u32| match m { 0xFF => Ok(0usize), 0xFF00 => Ok(1), 0xFF_0000 => Ok(2), 0xFF00_0000 => Ok(3), _ => Err("unsupported BMP bitfields") };
        for (i, o) in [54usize, 58, 62].into_iter().enumerate() { pos[i] = byte(u32at(o)?)?; }
        if hdr >= 56 { let m = u32at(66)?; if m != 0 { alpha = Some(byte(m)?); } }
    }
    let mut colour = cm::Colour::None;
    if hdr >= 124 {
        match u32at(70)? {
            0x7352_4742 | 0x5769_6E20 => colour = cm::Colour::Srgb, // LCS_sRGB 'sRGB', LCS_WINDOWS_COLOR_SPACE 'Win '
            0x4D42_4544 => { // PROFILE_EMBEDDED: offset from the start of the info header, size
                let (po, ps) = (14 + u32at(126)? as usize, u32at(130)? as usize);
                if let Some(p) = d.get(po..po.saturating_add(ps)) { if !p.is_empty() { colour = cm::Colour::Profile(p.to_vec()); } }
            }
            _ => {}
        }
    }
    let bytes = bpp / 8;
    let stride = (w * bytes + 3) & !3;
    let px = d.get(off..off + stride * h).ok_or("truncated BMP pixel data")?;
    let mut rgba = vec![0u8; w * h * 4];
    rgba.par_chunks_mut(w * 4).enumerate().for_each(|(y, dst)| {
        let sy = if top_down { y } else { h - 1 - y };
        let src = &px[sy * stride..sy * stride + w * bytes];
        match (bytes, alpha) {
            (3, _) => for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(3)) { d.copy_from_slice(&[s[2], s[1], s[0], 255]); },
            (_, Some(a)) => for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) { d.copy_from_slice(&[s[pos[0]], s[pos[1]], s[pos[2]], s[a]]); },
            (_, None) => for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) { d.copy_from_slice(&[s[pos[0]], s[pos[1]], s[pos[2]], 255]); },
        }
    });
    Ok(Image { w, h, rgba, is_png: false, depth16: false, colour })
}

// ---------------------------------------------------------------- lossless palette (<=256 colours)

#[inline(always)]
fn px_u32(p: &[u8]) -> u32 { u32::from_le_bytes([p[0], p[1], p[2], p[3]]) }

/// Palette + filter-None rows if the image has at most 256 distinct colours; bails out early otherwise
/// (a normal screenshot exceeds 256 colours within the first few rows of anti-aliased text).
fn try_exact(img: &Image) -> Option<(Vec<Rgba>, Vec<u8>)> {
    const CAP: usize = 1024;
    let mut keys = [0u32; CAP];
    let mut vals = [u16::MAX; CAP];
    let mut pal: Vec<Rgba> = Vec::with_capacity(256);
    // pass 1 (cheap, early exit): collect colours
    let (mut last, mut have_last) = (0u32, false);
    for p in img.rgba.chunks_exact(4) {
        let k = if p[3] == 0 { 0 } else { px_u32(p) };
        if have_last && k == last { continue; }
        last = k; have_last = true;
        let mut s = (k.wrapping_mul(0x9E37_79B1) >> 22) as usize;
        loop {
            if vals[s] == u16::MAX {
                if pal.len() == 256 { return None; }
                keys[s] = k; vals[s] = pal.len() as u16;
                let b = k.to_le_bytes();
                pal.push(Rgba { r: b[0], g: b[1], b: b[2], a: b[3] });
                break;
            }
            if keys[s] == k { break; }
            s = (s + 1) & (CAP - 1);
        }
    }
    // transparent entries first so that tRNS can be truncated
    let mut order: Vec<usize> = (0..pal.len()).collect();
    order.sort_by_key(|&i| pal[i].a == 255);
    let mut rank = [0u16; 256];
    for (new, &old) in order.iter().enumerate() { rank[old] = new as u16; }
    let pal: Vec<Rgba> = order.iter().map(|&i| pal[i]).collect();
    for v in vals.iter_mut() { if *v != u16::MAX { *v = rank[*v as usize]; } }
    // pass 2 (parallel): map pixels
    let mut raw = vec![0u8; (img.w + 1) * img.h];
    raw.par_chunks_mut(img.w + 1).zip(img.rgba.par_chunks(img.w * 4)).for_each(|(out, row)| {
        let (mut last, mut last_i) = (0u32, u16::MAX);
        for (p, o) in row.chunks_exact(4).zip(out[1..].iter_mut()) {
            let k = if p[3] == 0 { 0 } else { px_u32(p) };
            if k != last || last_i == u16::MAX {
                let mut s = (k.wrapping_mul(0x9E37_79B1) >> 22) as usize;
                while keys[s] != k || vals[s] == u16::MAX { s = (s + 1) & (CAP - 1); }
                last = k; last_i = vals[s];
            }
            *o = last_i as u8;
        }
    });
    Some((pal, raw))
}

// ---------------------------------------------------------------- quantization (palette only)

struct Built { pal: Vec<Rgba>, quality: Option<u8>, cells: Vec<(u32, u16)>, info: String, locked: Vec<bool> }
enum BuildErr { QualityTooLow, Other(String) }

/// Auto: aim for a ~1 MP sample. Palette quality does not improve beyond that; time does get worse.
fn sample_step(img: &Image, o: &Options) -> usize {
    match o.sample { 0 => (((img.w * img.h) as f64 / 1.2e6).sqrt().ceil() as usize).clamp(1, 4), n => n.max(1) }
}

/// One pixel per step x step block, at a hashed (jittered) position inside the block: thin lines and small icons
/// are then represented in proportion to their area instead of being hit or missed by a regular grid.
///
/// The column offset changes with every block, the row offset with every 4 blocks. With step 4 those 4 samples
/// then sit in one 64-byte cache line instead of up to four (the image is ~60 MB; this loop is memory-bound).
/// Measured: ~2 ms faster than a per-block row offset on a 5K image, and no slower than 16-block segments, while a
/// one-pixel-high line is still hit or missed per 16 px of its length rather than per 64 px.
/// Receives the samples; `row_end` is called after every sample row (the histogram breaks its runs there).
trait Sink {
    /// One sample, its context weight, whether it is non-flat (`ctx_weight`) and, when the sample is locally smooth
    /// (right and lower neighbours within 2 levels) and one of every 8th sample column, the colour of the pixel
    /// below it (the banding statistics of P27 count 1-level neighbour pairs in smooth places, like the
    /// false-contour judge of `tools/grey.py`; chosen by position, so that the bands of threads do not matter).
    /// `pair` carries (the pixel below, the pixel to the right); the right one is used by the P39 knob only.
    fn px(&mut self, k: u32, b: u32, nf: u32, smooth: bool, pair: Option<(u32, u32)>);
    fn row_end(&mut self) {}
}
impl Sink for quant::Hist {
    #[inline(always)] fn px(&mut self, k: u32, b: u32, nf: u32, smooth: bool, pair: Option<(u32, u32)>) { self.push_w(k, b, nf, smooth, pair) }
    #[inline(always)] fn row_end(&mut self) { self.end_row() }
}
impl Sink for Vec<u8> {
    #[inline(always)] fn px(&mut self, k: u32, _b: u32, _nf: u32, _smooth: bool, _pair: Option<(u32, u32)>) { self.extend_from_slice(&k.to_le_bytes()) }
}

/// Context weight of a sample (P24): a pixel inside a smooth gradient, where a missing shade shows as a band, counts
/// CTX_SMOOTH times in the palette design; a flat pixel (identical right and lower neighbours) and an edge pixel
/// (anti-aliasing, icons, noise: a neighbour more than CTX_EDGE levels away in some channel) count once. The weight
/// is a small integer, so the histogram sums stay exact and independent of the thread count. `SHOTQ_CTX` overrides.
const CTX_SMOOTH: u32 = 4;
const CTX_EDGE: i32 = 6;
fn ctx_smooth() -> u32 {
    static V: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *V.get_or_init(|| std::env::var("SHOTQ_CTX").ok().and_then(|s| s.parse().ok()).unwrap_or(CTX_SMOOTH).max(1))
}
/// Context weights are integers in 1/CTX_FP units, so the histogram sums stay exact whatever the thread count.
pub const CTX_FP: u32 = 16;
/// JND mode (P27, `SHOTQ_JND=1`): instead of the three classes, every sample gets the weight (3 / JND)^2, clamped to
/// [1/16, 1], where JND is the just-noticeable difference of Chou & Li's pixel-domain model: luminance adaptation
/// 3 + JND_DARK * (1 - sqrt(bg / 127)) below mid grey (17 in the paper: 20 levels at black) and 3 + 3 * (bg - 127) / 128
/// above it, combined by max with contrast masking JND_M * gradient (0.13 in the paper). A mid-grey sample in a
/// smooth gradient keeps weight 1; the same step on a dark background, a bright one, or next to an edge counts less.
/// `SHOTQ_JND_DARK` and `SHOTQ_JND_M` override the two slopes. `SHOTQ_JND=2` is the hybrid: the three P24 classes
/// (flat 1, smooth CTX_SMOOTH, edge 1) times the luminance-adaptation factor (3 / T_la)^2 alone, no masking term.
fn jnd_params() -> Option<(u8, f32, f32)> {
    static V: std::sync::OnceLock<Option<(u8, f32, f32)>> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        let mode: u8 = std::env::var("SHOTQ_JND").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
        if mode == 0 { return None; }
        let f = |name: &str, d: f32| std::env::var(name).ok().and_then(|s| s.parse().ok()).unwrap_or(d);
        Some((mode, f("SHOTQ_JND_DARK", 17.0), f("SHOTQ_JND_M", 0.13)))
    })
}
/// Returns (context weight in 1/CTX_FP units, non-flat: 1 if a neighbour differs at all, 0 inside a flat run).
/// A sample whose right and lower neighbours are within this many levels is "locally smooth" for the banding
/// statistics (P27): a missing shade there is a visible band; anywhere else a 1-level pair is noise or an edge.
const BAND_SMOOTH: u32 = 2;
#[inline(always)]
fn ctx_weight(p: &[u8], right: &[u8], below: Option<&[u8]>, smooth: u32, jnd: Option<(u8, f32, f32)>) -> (u32, u32, u32) {
    let d = |q: &[u8]| (0..4).map(|c| (p[c] as i32 - q[c] as i32).abs()).max().unwrap();
    let c = d(right).max(below.map_or(0, d));
    let class = if c > 0 && c <= CTX_EDGE { smooth } else { 1 };
    let b = match jnd {
        None => class * CTX_FP,
        Some((mode, dark, m)) => {
            let bg = 0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32;
            let t_la = if bg <= 127.0 { 3.0 + dark * (1.0 - (bg / 127.0).sqrt()) } else { 3.0 + 3.0 * (bg - 127.0) / 128.0 };
            let (t, scale) = if mode == 2 { (t_la, class as f32) } else { (t_la.max(m * c as f32), 1.0) };
            ((3.0 / t).powi(2) * scale * CTX_FP as f32).round().max(1.0) as u32
        }
    };
    (b, (c > 0) as u32, c as u32)
}

/// SHOTQ_SAMPLE_STRAT=1 (P39, experiment): stratified row offsets in the sampling (see `for_each_sample_b`).
fn sample_strat() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| std::env::var("SHOTQ_SAMPLE_STRAT").map_or(false, |s| s == "1"))
}

#[inline(always)]
fn for_each_sample(img: &Image, step: usize, rows: std::ops::Range<usize>, s: &mut impl Sink) {
    // monomorphic on the banding statistics, so that the default path carries no extra work per sample
    if quant::band_max() > 0.0 { for_each_sample_b::<true>(img, step, rows, s) } else { for_each_sample_b::<false>(img, step, rows, s) }
}
#[inline(always)]
fn for_each_sample_b<const BAND: bool>(img: &Image, step: usize, rows: std::ops::Range<usize>, s: &mut impl Sink) {
    let (w, smooth, jnd) = (img.w, ctx_smooth(), jnd_params());
    let row_at = |y: usize| &img.rgba[y * w * 4..(y + 1) * w * 4];
    let sample = |s: &mut dyn FnMut(u32, u32, u32, bool, Option<(u32, u32)>), row: &[u8], below: Option<&[u8]>, sx: usize, pick: bool| {
        let p = &row[sx * 4..sx * 4 + 4];
        let right = if sx + 1 < w { &row[sx * 4 + 4..sx * 4 + 8] } else { p };
        let under = below.map(|b| &b[sx * 4..sx * 4 + 4]);
        let (b, nf, c) = ctx_weight(p, right, under, smooth, jnd);
        let sm = BAND && c <= BAND_SMOOTH;
        s(px_u32(p), b, nf, sm, if sm && pick { Some((px_u32(under.unwrap_or(p)), px_u32(right))) } else { None });
    };
    if step == 1 {
        for y in rows {
            let (row, below) = (row_at(y), (y + 1 < img.h).then(|| row_at(y + 1)));
            for sx in 0..w { sample(&mut |k, b, nf, sm, u| s.px(k, b, nf, sm, u), row, below, sx, sx & 7 == 0); }
            s.row_end();
        }
        return;
    }
    let sw = w.div_ceil(step);
    let pick = |h: u32| ((h >> 16) as usize * step) >> 16; // 0..step from the top 16 bits, no division
    let strat = sample_strat();
    for y in rows {
        let hy = (y as u32).wrapping_mul(0x85EB_CA6B);
        for seg in (0..sw).step_by(4) {
            // SHOTQ_SAMPLE_STRAT=1 (P39): every `step` consecutive 4-sample segments take the `step` row offsets once
            // each (a cyclic shift chosen per block), so a 1-px horizontal line at least 4 * step * step pixels wide
            // is always sampled; by default the offset is hashed per segment (31.6% of such lines are never sampled
            // at step 4). The reads stay 4 samples per row either way.
            let off = if strat { let g = seg / 4; (g + pick((hy ^ ((g / step) as u32).wrapping_mul(0xC2B2_AE35)).wrapping_mul(0x9E37_79B1))) % step }
                      else { pick((hy ^ (seg as u32).wrapping_mul(0xC2B2_AE35)).wrapping_mul(0x9E37_79B1)) };
            let sy = (y * step + off).min(img.h - 1);
            let (row, below) = (row_at(sy), (sy + 1 < img.h).then(|| row_at(sy + 1)));
            for x in seg..(seg + 4).min(sw) {
                let sx = (x * step + pick((hy ^ x as u32).wrapping_mul(0x9E37_79B1))).min(w - 1);
                sample(&mut |k, b, nf, sm, u| s.px(k, b, nf, sm, u), row, below, sx, x & 7 == 0);
            }
        }
        s.row_end();
    }
}

fn build_palette(img: &Image, o: &Options, space: &ColorSpace) -> Result<Built, BuildErr> {
    let step = sample_step(img, o);
    if o.use_liq {
        let mut small = Vec::with_capacity(img.w.div_ceil(step) * img.h.div_ceil(step) * 4);
        for_each_sample(img, step, 0..img.h.div_ceil(step), &mut small);
        return build_palette_liq(&small, img.w.div_ceil(step), img.h.div_ceil(step), o);
    }
    let iterations = match o.speed { 11.. => 1, 8..=10 => 2, 5..=7 => 4, 3..=4 => 8, _ => 16 };
    // Histogram of the sampled pixels: one per thread over a contiguous band of sample rows, then merged.
    let t = Instant::now();
    let sh = img.h.div_ceil(step);
    // Each band costs a histogram (4 MB, 5 MB more if translucent) and a merge: worth it from ~64k samples per band.
    let bands = (sh * img.w.div_ceil(step) >> 16).clamp(1, rayon::current_num_threads().clamp(1, 8));
    let per = sh.div_ceil(bands).max(1);
    let ranges: Vec<_> = (0..sh).step_by(per).map(|a| a..(a + per).min(sh)).collect();
    // The text-mix row scan (P29, about 1 ms at 5K on its own) runs beside the histogram bands.
    let (hist, mixes) = rayon::join(
        || ranges.into_par_iter().map(|rows| {
            let mut h = quant::Hist::new();
            for_each_sample(img, step, rows, &mut h);
            h
        }).reduce_with(quant::Hist::merge).unwrap_or_else(quant::Hist::new),
        || mix_candidates(img));
    if std::env::var_os("SHOTQ_DEBUG").is_some() { eprintln!("  sample + histogram ({bands} band(s), every {step}th pixel) + text mixes ({} candidates): {:?}", mixes.len(), t.elapsed()); }
    match quant::quantize(space, hist, o.qmin, o.qmax, iterations, &mixes) {
        Ok(q) => Ok(Built { info: format!("{} bins", q.points), pal: q.palette, quality: Some(q.quality), cells: q.cells, locked: q.locked }),
        Err(_) => Err(BuildErr::QualityTooLow),
    }
}

/// Text mixing pairs (P29). Along every MIX_ROW_STEP-th row at full resolution, a gap of 1..=MIX_GAP pixels between
/// two runs of >= MIX_RUN identical opaque pixels holds anti-aliasing: the mixes of the runs' colours (a glyph stroke
/// thinner than the gap between two pieces of one background: the gap pixel farthest from the background stands in
/// for the foreground). For each (background, foreground) pair the mixes on the segment between the two are binned
/// by position (near 1/4, 1/2, 3/4); the mean colour of every bin with enough pixels is a candidate palette entry,
/// heaviest first, at most MIX_MAX. Measured on the real screenshots: the 32 heaviest pairs hold 83-95% of all gap
/// pixels. The scan is a strip-parallel pass over 1/8 of the rows (about 0.3 ms at 5K); its result is merged in key
/// order, so it does not depend on the thread count.
const MIX_ROW_STEP: usize = 8;
const MIX_RUN: usize = 4;
const MIX_GAP: usize = 3;
const MIX_MAX: usize = 24;
const MIX_MIN_PX: u32 = 12;
fn mix_candidates(img: &Image) -> Vec<Rgba> {
    use std::collections::HashMap;
    type Bins = HashMap<(u32, u32, u8), (u32, [u64; 3])>; // (bg, fg, t bin) -> (pixels, sum rgb)
    let w = img.w;
    let rows: Vec<usize> = (0..img.h).step_by(MIX_ROW_STEP).collect();
    let bins: Bins = rows.par_chunks(64).map(|chunk| {
        let mut bins: Bins = HashMap::new();
        for &y in chunk {
            let row = &img.rgba[y * w * 4..(y + 1) * w * 4];
            let px = |x: usize| u32::from_le_bytes([row[x * 4], row[x * 4 + 1], row[x * 4 + 2], row[x * 4 + 3]]);
            // runs of identical opaque pixels
            let mut runs: Vec<(usize, usize, u32)> = Vec::new();
            let (mut start, mut cur) = (0usize, px(0));
            for x in 1..=w {
                let k = if x < w { px(x) } else { !cur };
                if k != cur {
                    if x - start >= MIX_RUN && cur >> 24 == 255 { runs.push((start, x, cur)); }
                    start = x; cur = k;
                }
            }
            for i in 1..runs.len() {
                let ((_, e0, c0), (s1, _, c1)) = (runs[i - 1], runs[i]);
                let gap = s1 - e0;
                if gap == 0 || gap > MIX_GAP { continue; }
                let bg = c0.to_le_bytes();
                let dist = |k: u32| { let p = k.to_le_bytes(); (0..3).map(|c| (p[c] as i32 - bg[c] as i32).abs()).sum::<i32>() };
                let fg_key = if c0 == c1 { (e0..s1).map(px).max_by_key(|&k| dist(k)).unwrap() } else { c1 };
                let fg = fg_key.to_le_bytes();
                let seg = [fg[0] as f32 - bg[0] as f32, fg[1] as f32 - bg[1] as f32, fg[2] as f32 - bg[2] as f32];
                let l2 = seg.iter().map(|d| d * d).sum::<f32>();
                if l2 < 64.0 { continue; } // the two colours are within 8 levels: nothing to mix
                for x in e0..s1 {
                    let p = px(x).to_le_bytes();
                    if p[3] != 255 { continue; }
                    let d = [p[0] as f32 - bg[0] as f32, p[1] as f32 - bg[1] as f32, p[2] as f32 - bg[2] as f32];
                    let t = (d[0] * seg[0] + d[1] * seg[1] + d[2] * seg[2]) / l2;
                    let resid = (0..3).map(|c| (d[c] - t * seg[c]).powi(2)).sum::<f32>().sqrt();
                    if resid > 6.0 || !(0.125..0.875).contains(&t) { continue; }
                    let bin = ((t - 0.125) / 0.25) as u8; // 0: ~1/4, 1: ~1/2, 2: ~3/4
                    let e = bins.entry((c0, fg_key, bin)).or_insert((0, [0; 3]));
                    e.0 += 1; for c in 0..3 { e.1[c] += p[c] as u64; }
                }
            }
        }
        bins
    }).reduce(HashMap::new, |mut a, b| { for (k, v) in b { let e = a.entry(k).or_insert((0, [0; 3])); e.0 += v.0; for c in 0..3 { e.1[c] += v.1[c]; } } a });
    let mut list: Vec<((u32, u32, u8), (u32, [u64; 3]))> = bins.into_iter().filter(|(_, v)| v.0 >= MIX_MIN_PX).collect();
    list.sort_by(|a, b| b.1.0.cmp(&a.1.0).then(a.0.cmp(&b.0))); // heaviest first, then by key: deterministic
    if std::env::var_os("SHOTQ_DEBUG").is_some() {
        for ((bg, fg, t), (n, s)) in list.iter().take(MIX_MAX) { eprintln!("    mix {:?} {} px in scanned rows: bg {:06x} fg {:06x} t {}", [s[0] / *n as u64, s[1] / *n as u64, s[2] / *n as u64], n, bg, fg, t); }
    }
    list.iter().take(MIX_MAX).map(|(_, (n, s))| Rgba { r: ((s[0] + (*n as u64) / 2) / *n as u64) as u8, g: ((s[1] + (*n as u64) / 2) / *n as u64) as u8, b: ((s[2] + (*n as u64) / 2) / *n as u64) as u8, a: 255 }).collect()
}

#[cfg(feature = "liq")]
fn build_palette_liq(sample: &[u8], sw: usize, sh: usize, o: &Options) -> Result<Built, BuildErr> {
    use rgb::FromSlice;
    let run = || -> Result<Built, imagequant::Error> {
        let mut attr = imagequant::Attributes::new();
        attr.set_speed(o.speed.min(10))?;
        attr.set_quality(o.qmin, o.qmax)?;
        let mut liq = attr.new_image_borrowed(sample.as_rgba(), sw, sh, 0.0)?;
        let mut res = attr.quantize(&mut liq)?;
        let mut pal = res.palette().to_vec();
        pal.sort_by_key(|c| c.a == 255);
        let locked = vec![true; pal.len()]; // libimagequant's palette is measured as it is
        Ok(Built { pal, quality: res.quantization_quality(), cells: Vec::new(), info: "libimagequant".into(), locked })
    };
    run().map_err(|e| if matches!(e, imagequant::Error::QualityTooLow) { BuildErr::QualityTooLow } else { BuildErr::Other(e.to_string()) })
}
#[cfg(not(feature = "liq"))]
fn build_palette_liq(_: &[u8], _: usize, _: usize, _: &Options) -> Result<Built, BuildErr> { Err(BuildErr::Other("built without libimagequant".into())) }

// ---------------------------------------------------------------- remap

const EMPTY: u16 = 0xFFFF;
const SLOW: u16 = quant::CELL_SLOW; // cell holds more than one palette colour: resolve per pixel
/// Proof table (P43, `SHOTQ_LUT_PROOF=1`, experiment): a cell's single answer is used only once it is proved to be
/// the nearest entry for every colour of the cell (`Searcher::certify`); a cell where other entries can win holds
/// its candidates (up to 4) and every pixel of it is compared against them exactly; more candidates make the cell
/// SLOW. Flags in the cell table: CERT = proved single answer, AMB = candidates in the `amb` table, whose word
/// carries VALID and the count (a reader that finds the flag before the word recomputes: the proof is a pure
/// function of the cell and the palette, so the output never depends on the thread count).
const CERT: u16 = 0x4000;
const AMB: u16 = 0x8000;
const AMB_VALID: u64 = 1 << 63;
fn lut_proof() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| std::env::var("SHOTQ_LUT_PROOF").map_or(false, |s| s == "1"))
}
/// SHOTQ_LUT_PROOF_DELTA=k (experiment, with the proof table): a pixel of an ambiguous cell keeps the cell's answer
/// unless a candidate is nearer by more than k x Q_T85 (k = 0.1 is P33's tolerance): exactness within a margin,
/// which keeps the cell table's coherence (fewer transitions) where the answers are near ties.
fn proof_delta() -> f32 {
    static V: std::sync::OnceLock<f32> = std::sync::OnceLock::new();
    *V.get_or_init(|| (std::env::var("SHOTQ_LUT_PROOF_DELTA").ok().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0).max(0.0) * quant::quality_to_mse(85)) as f32)
}
#[derive(Default)]
struct ProofCount { exact: AtomicUsize, amb: AtomicUsize, slow: AtomicUsize, quick: AtomicUsize, scanned: AtomicUsize, full: AtomicUsize }
/// Per-band counters (plain integers: the shared atomics would be contended by every proof), merged once per band.
#[derive(Default)]
struct ProofLocal { exact: usize, amb: usize, slow: usize, quick: usize, scanned: usize, full: usize }
impl ProofCount {
    fn add(&self, l: &ProofLocal) {
        self.exact.fetch_add(l.exact, Ordering::Relaxed); self.amb.fetch_add(l.amb, Ordering::Relaxed); self.slow.fetch_add(l.slow, Ordering::Relaxed);
        self.quick.fetch_add(l.quick, Ordering::Relaxed); self.scanned.fetch_add(l.scanned, Ordering::Relaxed); self.full.fetch_add(l.full, Ordering::Relaxed);
    }
}
#[inline(always)]
fn pack_candidates(c: &[u16; 4], n: usize) -> u64 {
    let mut w = AMB_VALID | (n as u64) << 32;
    for (k, &j) in c.iter().take(n).enumerate() { w |= (j as u64 & 0xFF) << (8 * k); }
    w
}

#[inline(always)]
fn cell(r: u8, g: u8, b: u8) -> usize { ((r as usize) >> 2) << 12 | ((g as usize) >> 2) << 6 | (b as usize) >> 2 }

/// The 18-bit colour-cell table: palette colours own their cell (so colours the quantizer kept exact stay exact),
/// cells the quantizer already assigned while clustering the sample are pre-filled, a cell whose sample points went
/// to different entries is SLOW (resolved per pixel), everything else is EMPTY until first touched.
/// When the remapper's difference is not the design one (`Searcher::same_metric_as_design`), the design's cell
/// answers are not reused: only SLOW markers are taken, and every other cell is resolved on first touch with the
/// remapper's own difference (one search per touched cell, a fraction of a millisecond).
fn build_lut(pal: &[Rgba], cells: &[(u32, u16)], reuse_design: bool) -> Vec<AtomicU16> {
    let lut: Vec<AtomicU16> = (0..1 << 18).map(|_| AtomicU16::new(EMPTY)).collect();
    for (i, c) in pal.iter().enumerate() {
        if c.a != 255 { continue; }
        let slot = &lut[cell(c.r, c.g, c.b)];
        let cur = slot.load(Ordering::Relaxed);
        slot.store(if cur == EMPTY || cur == i as u16 { i as u16 } else { SLOW }, Ordering::Relaxed);
    }
    for &(c, i) in cells {
        let slot = &lut[c as usize];
        if i == SLOW { slot.store(SLOW, Ordering::Relaxed); } else if reuse_design && slot.load(Ordering::Relaxed) == EMPTY { slot.store(i, Ordering::Relaxed); }
    }
    lut
}

/// Near-neutral opaque pixels (|r - g| <= 3 and |b - g| <= 3) are resolved exactly through this table, keyed by the
/// exact colour: (g, r - g + 3, b - g + 3), 256 x 7 x 7 entries, 25 KB, filled on first touch (P18). The 6-bit cell
/// table answered for a whole cell of 4 levels per channel, which cost 0.3-1.0 dB of luma PSNR on the neutral pixels
/// of real screenshots (9% of tabby's pixels were not mapped to their nearest entry) once the palette had grey shades
/// closer together than a cell. Chromatic pixels are unaffected, so noisy photographs keep the cell table's speed.
fn fine_table() -> Vec<AtomicU16> { (0..256 * 49).map(|_| AtomicU16::new(EMPTY)).collect() }
#[inline(always)]
fn fine_index(p: [u8; 4]) -> Option<usize> {
    let (r, g, b) = (p[0] as i32, p[1] as i32, p[2] as i32);
    let (dr, db) = (r - g + 3, b - g + 3);
    if p[3] == 255 && (dr as u32) < 7 && (db as u32) < 7 { Some(g as usize * 49 + dr as usize * 7 + db as usize) } else { None }
}

/// Palette entry for one pixel: the cell table for opaque pixels (an EMPTY cell gets the exact nearest entry of its
/// centre, so the answer does not depend on thread scheduling), the per-band exact cache plus the exact search for
/// SLOW cells and translucent pixels. `last` seeds the search.
#[inline(always)]
fn palette_index<const PROOF: bool>(p: [u8; 4], last: u16, lut: &[AtomicU16], amb: &[AtomicU64], fine: &[AtomicU16], pf: &quant::Searcher, space: &ColorSpace, cache: &mut [(u32, u16)], cnt: &mut ProofLocal) -> u16 {
    if let Some(k) = fine_index(p) {
        let mut v = fine[k].load(Ordering::Relaxed);
        if v == EMPTY { v = pf.nearest(space, p, space.conv(p[0], p[1], p[2], 255), last as usize); fine[k].store(v, Ordering::Relaxed); }
        return v;
    }
    let mut v = if p[3] == 255 { lut[cell(p[0], p[1], p[2])].load(Ordering::Relaxed) } else { SLOW };
    if PROOF && v != SLOW {
        let (c, lo) = (cell(p[0], p[1], p[2]), [p[0] & !3, p[1] & !3, p[2] & !3]);
        if v == EMPTY {
            let m = [lo[0] | 2, lo[1] | 2, lo[2] | 2, 255];
            v = pf.nearest(space, m, space.conv(m[0], m[1], m[2], 255), last as usize);
        }
        if v & (CERT | AMB) == 0 {
            // an answer not yet proved: the design's answer for the cell, a palette colour's own cell, or the one just found
            let mut cand = [EMPTY; 4];
            let (res, quick, scanned, full) = pf.certify_stats(space, lo, v as usize, &mut cand);
            if quick { cnt.quick += 1; } cnt.scanned += scanned; if full { cnt.full += 1; }
            match res {
                Some(0) => { lut[c].store(v | CERT, Ordering::Relaxed); cnt.exact += 1; return v; }
                Some(n) => { amb[c].store(pack_candidates(&cand, n), Ordering::Relaxed); lut[c].store(v | AMB, Ordering::Relaxed); cnt.amb += 1; v |= AMB; }
                None => { lut[c].store(SLOW, Ordering::Relaxed); cnt.slow += 1; v = SLOW; }
            }
        }
        if v != SLOW && v & AMB != 0 {
            // the same per-band cache as the SLOW cells (keyed by the exact colour; both hold the exact nearest entry)
            let kk = u32::from_le_bytes(p);
            let e = &mut cache[(kk.wrapping_mul(0x9E37_79B1) >> 20) as usize];
            if e.0 != kk || e.1 == EMPTY {
                let own = (v & 0xFF) as usize;
                let mut w = amb[c].load(Ordering::Relaxed);
                if w & AMB_VALID == 0 { // the flag arrived before the word: redo the (deterministic) proof
                    let mut cand = [EMPTY; 4];
                    match pf.certify(space, lo, own, &mut cand) { Some(n) if n > 0 => { w = pack_candidates(&cand, n); amb[c].store(w, Ordering::Relaxed); } _ => { w = 0; } }
                }
                let cv = space.conv(p[0], p[1], p[2], 255);
                let d_own = pf.dist(&cv, own);
                let (mut best, mut bd) = (own, d_own);
                if w == 0 { best = pf.nearest(space, p, cv, last as usize) as usize; } else {
                    for k in 0..((w >> 32) & 0xF) as usize {
                        let j = ((w >> (8 * k)) & 0xFF) as usize;
                        let d = pf.dist(&cv, j);
                        if d < bd || (d == bd && j < best) { best = j; bd = d; }
                    }
                    // with a margin, the cell's answer stays unless the winner is nearer by more than it
                    if best != own && d_own - bd <= proof_delta() { best = own; }
                }
                *e = (kk, best as u16);
            }
            return e.1;
        }
        if v != SLOW && v & CERT != 0 { return v & 0xFF; }
    }
    if v == EMPTY {
        let c = [p[0] & !3 | 2, p[1] & !3 | 2, p[2] & !3 | 2, 255];
        v = pf.nearest(space, c, space.conv(c[0], c[1], c[2], 255), last as usize);
        lut[cell(p[0], p[1], p[2])].store(v, Ordering::Relaxed);
    } else if v == SLOW {
        let kk = if p[3] == 0 { 0 } else { u32::from_le_bytes(p) };
        let e = &mut cache[(kk.wrapping_mul(0x9E37_79B1) >> 20) as usize];
        if e.0 != kk || e.1 == EMPTY {
            let c = kk.to_le_bytes();
            *e = (kk, pf.nearest(space, c, space.conv(c[0], c[1], c[2], c[3]), last as usize));
        }
        v = e.1;
    }
    v
}

/// Per palette entry, over the opaque pixels written with it: count, sum of r, g, b, and the count of those pixels
/// that lie in a run of RUN_MIN or more identical pixels (flat content: panels, backgrounds; the edge sub-palette
/// leaves entries alone whose pixels are mostly such). The sum of squares was dropped in P38: it cancels in the
/// palette correction's comparison.
type EntryStats = [u64; 5];

#[inline(always)]
fn flush_run(s: &mut EntryStats, k: u32, run: u64) {
    let [r, g, b, a] = k.to_le_bytes();
    if a != 255 || run == 0 { return; }
    let (r, g, b) = (r as u64, g as u64, b as u64);
    s[0] += run; s[1] += run * r; s[2] += run * g; s[3] += run * b;
    if run >= quant::RUN_MIN as u64 { s[4] += run; }
}

/// Run merging in the remap (P33): a run of pixels that would all be written with one entry takes the entry of the
/// run to its left instead when, for every pixel of the run, that entry is at most `HYST` times the `--quality`
/// target farther (in the remap metric) than the pixel's own entry. A transition between two runs then disappears
/// and none is created; pixels that equal a palette colour exactly never move (flat colours stay exact), nor do
/// translucent pixels or runs next to a translucent entry. Decided row by row from the left, so the output does not
/// depend on the thread count. Measured in Python before the port (results/size-study-2026-09-20/hyst-all.txt):
/// at 0.05-0.1 the real screenshots lose no PSNR and have 30% fewer false contours for -2% bytes (the owner's light
/// UI -1%, noisy and photographic images -7..-20%); 0.15 and above starts banding gradients. `SHOTQ_HYST` overrides,
/// 0 reproduces the 0.17.0 output.
const HYST: f64 = 0.1;
fn hyst() -> f64 {
    static V: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
    *V.get_or_init(|| std::env::var("SHOTQ_HYST").ok().and_then(|s| s.parse().ok()).unwrap_or(HYST).max(0.0))
}

/// Ends the open run `out[1 + start..1 + end]` of entry `cur` whose statistics are in `acc`: it takes `prev` when
/// `ok` (the bytes are rewritten, so no transition is left between the two runs), else keeps `cur`. Returns the
/// entry the next run sees on its left.
#[inline(always)]
fn close_run(out: &mut [u8], st: &mut [EntryStats], acc: &mut EntryStats, start: usize, end: usize, cur: u16, prev: u16, ok: bool) -> u16 {
    if cur == EMPTY || start >= end { return prev; }
    let e = if ok && prev != cur { out[1 + start..1 + end].fill(prev as u8); prev } else { cur };
    let s = &mut st[e as usize];
    for d in 0..5 { s[d] += acc[d]; }
    *acc = [0; 5];
    e
}

/// Writes filter-None rows ([0, idx, idx, ...]) straight into the deflate input buffer and returns, per palette
/// entry, the statistics of the opaque pixels written with it (accumulated once per run of identical pixels, so
/// flat UI costs nothing; summed over the bands in whatever order, which is exact for integers): the input of
/// `correct_palette`. With `MERGE` (`SHOTQ_MERGE_LATE=0`) it also merges runs into their left neighbour's entry
/// within `eps` (P33, `close_run`) and credits a run's statistics to the entry it ends up with; the default
/// instantiation (P42's order, the merge as a pass after the correction) carries none of that (P44).
fn remap<const PROOF: bool, const MERGE: bool>(img: &Image, pal: &[Rgba], space: &ColorSpace, cells: &[(u32, u16)], eps: f32) -> (Vec<u8>, Vec<EntryStats>) {
    debug_assert!(MERGE || eps == 0.0);
    let mut pf = quant::Searcher::new(space, pal);
    if PROOF { pf.build_planes(); }
    let (lut, fine) = (build_lut(pal, cells, pf.same_metric_as_design()), fine_table());
    if PROOF && std::env::var_os("SHOTQ_DEBUG").is_some() { eprintln!("  remap: design cells {} of which {} SLOW; palette {} entries", cells.len(), cells.iter().filter(|c| c.1 == SLOW).count(), pal.len()); }
    let amb: Vec<AtomicU64> = if PROOF { (0..1 << 18).map(|_| AtomicU64::new(0)).collect() } else { Vec::new() };
    let cnt = ProofCount::default();
    let opaque: Vec<bool> = if MERGE { pal.iter().map(|c| c.a == 255).collect() } else { Vec::new() };
    let w = img.w;
    // 32-row bands keep the per-band exact cache warm on big images; small images get more, shorter bands so that
    // all threads take part (a 300-row image is 75 bands of 4 rows, not 10 bands of 32).
    let band = (img.h / (4 * rayon::current_num_threads().max(1))).clamp(4, 32);
    let mut raw = vec![0u8; (w + 1) * img.h];
    let stats = raw.par_chunks_mut((w + 1) * band).zip(img.rgba.par_chunks(w * 4 * band)).map(|(out, src)| {
        let mut cache = vec![(0u32, EMPTY); 4096]; // exact cache for SLOW cells and translucent pixels
        let mut st = vec![[0u64; 5]; pal.len()];
        let mut pl = ProofLocal::default();
        let (mut last, mut last_i, mut run) = (0u32, EMPTY, 0u64);
        for (row, out) in src.chunks_exact(w * 4).zip(out.chunks_exact_mut(w + 1)) {
            // Run merging (P33, only with MERGE), per row: `prev` is the entry of the run to the left (final), `cur`
            // the entry of the open run, which began at `start` and may still take `prev` while `ok`; `acc` keeps
            // the open run's statistics until its entry is decided. A run of identical pixels crossing the row end
            // goes on as this row's first run, with nothing on its left. Without MERGE a run's statistics go
            // straight to its entry (`last_i`, which is `cur` at every flush).
            let (mut prev, mut cur, mut start, mut ok) = (EMPTY, last_i, 0usize, false);
            let mut acc = [0u64; 5];
            for x in 0..w {
                let p = &row[x * 4..x * 4 + 4];
                let k = px_u32(p);
                if k == last && last_i != EMPTY { out[1 + x] = last_i as u8; run += 1; continue; }
                if last_i != EMPTY { flush_run(if MERGE { &mut acc } else { &mut st[last_i as usize] }, last, run); }
                let rgba = [p[0], p[1], p[2], p[3]];
                let v = palette_index::<PROOF>(rgba, last_i, &lut, &amb, &fine, &pf, space, &mut cache, &mut pl);
                if MERGE && v != cur {
                    prev = close_run(out, &mut st, &mut acc, start, x, cur, prev, ok);
                    cur = v; start = x; ok = eps > 0.0 && prev != EMPTY && prev != v && opaque[prev as usize];
                }
                if MERGE && ok {
                    // one test per source colour: a run of identical pixels shares its result
                    ok = rgba[3] == 255 && {
                        let c = space.conv(rgba[0], rgba[1], rgba[2], 255);
                        let own = pf.dist(&c, v as usize);
                        own > 0.0 && pf.dist(&c, prev as usize) - own <= eps
                    };
                }
                last = k; last_i = v; run = 1; out[1 + x] = v as u8;
            }
            if last_i != EMPTY { flush_run(if MERGE { &mut acc } else { &mut st[last_i as usize] }, last, run); run = 0; }
            if MERGE { close_run(out, &mut st, &mut acc, start, w, cur, prev, ok); }
        }
        if PROOF { cnt.add(&pl); }
        st
    }).reduce(|| vec![[0u64; 5]; pal.len()], |mut a, b| { for (x, y) in a.iter_mut().zip(&b) { for d in 0..5 { x[d] += y[d]; } } a });
    if PROOF && std::env::var_os("SHOTQ_DEBUG").is_some() { eprintln!("  remap: proof table: {} cells proved exact ({} by the quick test), {} with candidates, {} made slow; {} neighbours scanned, {} full scans", cnt.exact.load(Ordering::Relaxed), cnt.quick.load(Ordering::Relaxed), cnt.amb.load(Ordering::Relaxed), cnt.slow.load(Ordering::Relaxed), cnt.scanned.load(Ordering::Relaxed), cnt.full.load(Ordering::Relaxed)); }
    (raw, stats)
}

/// Run merging after the palette correction (P42, default since 0.22.0; docs/contracts-plan.md, order variant V-2).
/// The remap writes the plain assignment and its statistics, `correct_palette` moves the entries, and `merge_runs`
/// merges against the corrected palette, so P33's admission test holds for the palette that is written (comparison
/// A) instead of the one it was measured on. Measured (HANDOFF P42): owner's screenshots -0.04%, public -0.10%, grey
/// ramps -4.4% bytes, PSNR and the grey judges unchanged, 4-21% more runs merged (merges that only the corrected
/// palette admits); one more pass over the index rows and the pixels: +0.6-0.9 ms at 5K, +3.8 ms on the 5K photo,
/// +0.1-1.0 ms on the owner's screenshots (the owner took the guarantee over the time). `SHOTQ_MERGE_LATE=0` merges
/// inside the remap against the design palette as 0.18.0-0.21.0 did (byte-identical to 0.21.0).
const MERGE_LATE: bool = true;
fn merge_late() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| std::env::var("SHOTQ_MERGE_LATE").map_or(MERGE_LATE, |s| s != "0"))
}

/// Run merging as a pass of its own over the written rows (P42, `merge_late`): the rule of `remap` / `close_run`
/// against `pal`. A run of one entry takes the final entry of the run to its left when every pixel of the run is
/// opaque, not an exact palette colour (`own > 0`) and at most `eps` farther from that entry than from its own, one
/// test per source colour; the first run of a row has no left neighbour, a translucent left entry never receives a
/// run. Decided row by row from the left in bands of whole rows, so the output does not depend on the thread count.
/// The merged pixels are not credited to the statistics (the correction has already used them). Returns how many
/// pixels moved. With the palette the remap used, the result equals the in-remap merging (unit test).
fn merge_runs(img: &Image, pal: &[Rgba], space: &ColorSpace, raw: &mut [u8], eps: f32) -> (usize, usize, usize) {
    if eps <= 0.0 { return (0, 0, 0); }
    let pf = quant::Searcher::dist_only(space, pal);
    let opaque: Vec<bool> = pal.iter().map(|c| c.a == 255).collect();
    let keys: Vec<u32> = pal.iter().map(|c| u32::from_le_bytes([c.r, c.g, c.b, c.a])).collect(); // a pixel equal to its entry has own == 0: no test needed
    let w = img.w;
    let band = (img.h / (4 * rayon::current_num_threads().max(1))).clamp(4, 32);
    raw.par_chunks_mut((w + 1) * band).zip(img.rgba.par_chunks(w * 4 * band)).map(|(out, src)| {
        let (mut merged, mut runs, mut tests) = (0usize, 0usize, 0usize);
        for (row, out) in src.chunks_exact(w * 4).zip(out.chunks_exact_mut(w + 1)) {
            let (mut prev, mut x) = (EMPTY, 0usize);
            while x < w {
                let cur8 = out[1 + x]; let cur = cur8 as u16;
                // The run's end: 8 index bytes per compare while 8 remain, then byte by byte (P45: an early-exit
                // `position` compiles to a byte loop, and 78-86% of a screenshot's pixels lie in runs of 16+).
                let (mut end, cur64) = (x + 1, u64::from_le_bytes([cur8; 8]));
                while end + 8 <= w && u64::from_le_bytes(out[1 + end..9 + end].try_into().unwrap()) == cur64 { end += 8; }
                while end < w && out[1 + end] == cur8 { end += 1; }
                runs += 1;
                let mut ok = prev != EMPTY && prev != cur && opaque[prev as usize];
                if ok {
                    let (mut last, mut last128, mut first, mut i) = (0u32, 0u128, true, x);
                    while i < end {
                        let p = &row[i * 4..i * 4 + 4];
                        let k = px_u32(p);
                        if !first && k == last {
                            // a run of identical pixels shares its result: four pixels per compare while they last
                            i += 1;
                            while i + 4 <= end && u128::from_le_bytes(row[i * 4..i * 4 + 16].try_into().unwrap()) == last128 { i += 4; }
                            continue;
                        }
                        first = false; last = k;
                        last128 = (k as u128) | (k as u128) << 32 | (k as u128) << 64 | (k as u128) << 96;
                        if k == keys[cur as usize] { ok = false; break; } // an exact palette colour never moves
                        tests += 1;
                        ok = p[3] == 255 && {
                            let c = space.conv(p[0], p[1], p[2], 255);
                            let own = pf.dist(&c, cur as usize);
                            own > 0.0 && pf.dist(&c, prev as usize) - own <= eps
                        };
                        if !ok { break; }
                        i += 1;
                    }
                }
                if ok { out[1 + x..1 + end].fill(prev as u8); merged += end - x; } else { prev = cur; }
                x = end;
            }
        }
        (merged, runs, tests)
    }).reduce(|| (0, 0, 0), |a, b| (a.0 + b.0, a.1 + b.1, a.2 + b.2))
}

/// Moves each unlocked opaque palette entry to the rounded mean of the pixels actually written with it, when that
/// lowers their RGB squared error (P20). The palette came from a ~1 MP sample with a 10% weight cap; the mean over
/// every pixel is the k-means optimum for the fixed index map, so the correction is free of side effects: the
/// index map, the palette size and order, the alpha values and the compressed bytes are untouched (the PLTE holds
/// different values). Entries pinned or snapped to an exact flat colour are locked and stay. Returns how many
/// entries moved and the largest move in any channel.
fn correct_palette(pal: &mut [Rgba], stats: &[EntryStats], locked: &[bool]) -> (usize, i32) {
    let (mut moved, mut worst) = (0usize, 0i32);
    for (i, c) in pal.iter_mut().enumerate() {
        let s = stats[i];
        if locked[i] || c.a != 255 || s[0] == 0 { continue; }
        let n = s[0];
        let mean = [((s[1] + n / 2) / n) as u8, ((s[2] + n / 2) / n) as u8, ((s[3] + n / 2) / n) as u8];
        if mean == [c.r, c.g, c.b] { continue; }
        // sum |p - c|^2 = sum |p|^2 - 2 c . sum p + n |c|^2, and sum |p|^2 is the same for both candidates: the mean
        // wins iff n (|mean|^2 - |c|^2) - 2 (mean - c) . sum p < 0, exact in integers (P38)
        let part = |q: [u8; 3]| -> i128 { let q = q.map(|v| v as i128); n as i128 * (q[0] * q[0] + q[1] * q[1] + q[2] * q[2]) - 2 * (q[0] * s[1] as i128 + q[1] * s[2] as i128 + q[2] * s[3] as i128) };
        if part(mean) < part([c.r, c.g, c.b]) {
            worst = worst.max((0..3).map(|d| (mean[d] as i32 - [c.r, c.g, c.b][d] as i32).abs()).max().unwrap());
            c.r = mean[0]; c.g = mean[1]; c.b = mean[2]; moved += 1;
        }
    }
    (moved, worst)
}

/// A row of at least this many identical pixels, with identical rows above and below, is a flat area (a panel, a
/// background): diffused error there would only paint speckles. A shadow's alpha changes every few pixels.
const FLAT_RUN: usize = 8;
/// A 4-neighbour that differs by more than this in some channel (8-bit, alpha included) makes an edge: text,
/// icons, noise. Dithering is invisible there and costs bytes. Measured on the bench set at strength 1: without
/// this rule the real screenshots are 10% bigger (helix +13%, AppFlowy +64%); 8 instead of 16 saves another 1.3%,
/// and the run rule (4, 8 or 16 pixels) moves the total by under 1%.
const EDGE_DIFF: i32 = 16;

/// Per-pixel switch for `remap_dithered`, the counterpart of pngquant's dither map: 1 where the source varies
/// smoothly (shadows, gradients, smooth photo areas), 0 on flat areas (`FLAT_RUN`) and edges (`EDGE_DIFF`), which
/// get the plain nearest colour, as `remap` gives, and pass no error on. A pure function of the source image, so
/// the parallel pass and the serial reference agree and the output does not depend on the thread count.
fn dither_gate(img: &Image, y: usize, gate: &mut [u8]) {
    let w = img.w;
    let row = |yy: usize| &img.rgba[yy * w * 4..(yy + 1) * w * 4];
    let (cur, up, down) = (row(y), row(y.saturating_sub(1)), row((y + 1).min(img.h - 1)));
    let px = |r: &[u8], x: usize| u32::from_le_bytes([r[x * 4], r[x * 4 + 1], r[x * 4 + 2], r[x * 4 + 3]]);
    let far = |a: u32, b: u32| a.to_le_bytes().iter().zip(b.to_le_bytes()).any(|(&x, y)| (x as i32 - y as i32).abs() > EDGE_DIFF);
    // pass 1: long runs
    let mut start = 0;
    for x in 1..=w {
        if x == w || px(cur, x) != px(cur, start) {
            let long = (x - start >= FLAT_RUN) as u8;
            for g in &mut gate[start..x] { *g = long; }
            start = x;
        }
    }
    // pass 2: flat (long run inside identical rows) or edge -> 0; the comparisons are skipped for equal pixels,
    // so a flat screenshot costs one load per neighbour
    for x in 0..w {
        let (p, pu, pd) = (px(cur, x), px(up, x), px(down, x));
        if gate[x] != 0 && p == pu && p == pd { gate[x] = 0; continue; }
        let mut edge = (p != pu && far(p, pu)) || (p != pd && far(p, pd));
        if x > 0 { let pl = px(cur, x - 1); edge |= p != pl && far(p, pl); }
        if x + 1 < w { let pr = px(cur, x + 1); edge |= p != pr && far(p, pr); }
        gate[x] = (!edge) as u8;
    }
}

/// Floyd-Steinberg error diffusion (7/16 right, 3/16 below-left, 5/16 below, 1/16 below-right), `strength` 0..1.
/// Errors are integers in sixteenths of a code value, so the result is exactly that of a serial pass whatever the
/// thread count. Rows run in parallel with a skew: a thread takes the next row and follows the row above, which
/// must be two pixels ahead (pixel (x, y) receives error from (x+1, y-1)). The errors a row hands down live in a
/// ring of rows; a row may reuse a slot once the row that read it has finished. Like the PNG reader this is a chain
/// of dependent work, so it runs on the performance cores only. Pixels that `dither_gate` switches off (flat areas,
/// edges) take the plain nearest colour of their source value, ignore incoming error and pass none on.
fn remap_dithered(img: &Image, pal: &[Rgba], space: &ColorSpace, cells: &[(u32, u16)], strength: f32) -> Vec<u8> {
    const STEP: usize = 32; // pixels between progress publications
    // A colour with no palette entry near it would otherwise push an ever-growing error into its neighbours (the
    // "worms" of plain Floyd-Steinberg; kitty's max colour difference went to 78). The error a pixel hands on is
    // capped to this many code values per channel.
    const CAP: i32 = 16;
    let pf = quant::Searcher::new(space, pal);
    let (lut, fine) = (build_lut(pal, cells, pf.same_metric_as_design()), fine_table());
    let (w, h) = (img.w, img.h);
    let s16 = (strength.clamp(0.0, 1.0) * 16.0).round() as i32;
    let palc: Vec<[i32; 4]> = pal.iter().map(|c| [c.r as i32, c.g as i32, c.b as i32, c.a as i32]).collect();
    let workers = rayon::current_num_threads().max(1).min(performance_cores().unwrap_or(usize::MAX)).min(h.max(1));
    let ring_n = 2 * workers + 2;
    let mut ring = vec![[0i32; 4]; ring_n * w]; // slot y % ring_n holds the error handed down to row y
    let mut raw = vec![0u8; (w + 1) * h];
    let progress: Vec<Progress> = (0..h).map(|_| Progress(AtomicUsize::new(0))).collect();
    let next_row = AtomicUsize::new(0);
    let (rp, op) = (SendPtr(ring.as_mut_ptr()), SendPtr(raw.as_mut_ptr()));
    let worker = || {
        let mut cache = vec![(0u32, EMPTY); 4096];
        let mut gate = vec![0u8; w];
        loop {
            let y = next_row.fetch_add(1, Ordering::Relaxed);
            if y >= h { break; }
            dither_gate(img, y, &mut gate);
            // the slot this row writes was read by row y + 1 - ring_n: wait for it
            if y + 1 >= ring_n { while progress[y + 1 - ring_n].0.load(Ordering::Acquire) < w { std::hint::spin_loop(); } }
            // SAFETY: row y is the only writer of its output row and of ring slot (y+1) % ring_n, and the only reader
            // of slot y % ring_n; it reads element x of that slot only after row y-1 (its writer) has passed pixel
            // x+1 (the progress waits below), and slot (y+1) % ring_n is free once row y+1-ring_n has finished (the
            // wait above). The ring is accessed element by element through raw pointers, never through a slice over
            // a row: row y-1 is still writing the later elements of the slot row y reads, so a shared slice over the
            // whole row would alias its exclusive access. Buffers outlive the scope.
            let src = &img.rgba[y * w * 4..(y + 1) * w * 4];
            let out = unsafe { std::slice::from_raw_parts_mut(op.get().add(y * (w + 1)), w + 1) };
            let inc = unsafe { rp.get().add((y % ring_n) * w) } as *const [i32; 4];
            let nxt = unsafe { rp.get().add(((y + 1) % ring_n) * w) };
            out[0] = 0;
            let (mut carry, mut last_i, mut plain) = ([0i32; 4], 0u16, (0u32, EMPTY));
            for x in 0..w {
                if y > 0 && x % STEP == 0 { let need = (x + STEP + 2).min(w); while progress[y - 1].0.load(Ordering::Acquire) < need { std::hint::spin_loop(); } }
                let p = &src[x * 4..x * 4 + 4];
                let mut e = [0i32; 4];
                let idx = if gate[x] != 0 && p[3] != 0 {
                    let mut v = [0u8; 4];
                    let inc_x = unsafe { std::ptr::read(inc.add(x)) };
                    for k in 0..4 { v[k] = (p[k] as i32 + ((inc_x[k] + carry[k] + 8) >> 4)).clamp(0, 255) as u8; }
                    let idx = palette_index::<false>(v, last_i, &lut, &[], &fine, &pf, space, &mut cache, &mut ProofLocal::default());
                    let c = palc[idx as usize];
                    for k in 0..4 { e[k] = (((v[k] as i32 - c[k]) * s16) >> 4).clamp(-CAP, CAP); }
                    idx
                } else { // flat, edge or transparent: the plain answer, a pure function of the source colour (reused across runs)
                    let k = px_u32(p);
                    if k != plain.0 || plain.1 == EMPTY { plain = (k, palette_index::<false>([p[0], p[1], p[2], p[3]], last_i, &lut, &[], &fine, &pf, space, &mut cache, &mut ProofLocal::default())); }
                    plain.1
                };
                last_i = idx;
                out[x + 1] = idx as u8;
                for k in 0..4 { carry[k] = e[k] * 7; }
                unsafe {
                    if x > 0 { let (l, m) = (nxt.add(x - 1), nxt.add(x)); for k in 0..4 { (*l)[k] += e[k] * 3; (*m)[k] += e[k] * 5; } } else { std::ptr::write(nxt, e.map(|e| e * 5)); }
                    if x + 1 < w { std::ptr::write(nxt.add(x + 1), e); }
                }
                if (x + 1) % STEP == 0 { progress[y].0.store(x + 1, Ordering::Release); }
            }
            progress[y].0.store(w, Ordering::Release);
        }
    };
    if workers == 1 { worker(); } else { rayon::scope(|sc| for _ in 0..workers { sc.spawn(|_| worker()); }); }
    raw
}

/// Diagnostic (SHOTQ_CHECK_QUALITY=1): shotq's reported quality comes from the ~1 MP sample with the 10% weight cap.
/// This prints it next to the same metric over every pixel, and, in `--features liq` builds, next to what
/// libimagequant reports after remapping the whole image to exactly this palette (its colours added as fixed).
fn check_quality(img: &Image, pal: &[Rgba], raw: &[u8], space: &ColorSpace, reported: Option<u8>) {
    let full = quant::image_quality(space, &img.rgba, pal, raw, img.w);
    let liq = liq_quality_of_palette(img, pal);
    eprintln!("quality check: shotq sample {} | shotq full image {} | libimagequant remap {}", reported.map_or("?".into(), |q| q.to_string()), full,
        liq.map_or("n/a (build with --features liq)".to_string(), |q| q.to_string()));
}

#[cfg(feature = "liq")]
fn liq_quality_of_palette(img: &Image, pal: &[Rgba]) -> Option<u8> {
    use rgb::FromSlice;
    let mut attr = imagequant::Attributes::new();
    attr.set_max_colors(pal.len() as u32).ok()?;
    attr.set_quality(0, 100).ok()?;
    attr.set_speed(1).ok()?;
    let mut image = attr.new_image_borrowed(img.rgba.as_rgba(), img.w, img.h, 0.0).ok()?;
    for c in pal { image.add_fixed_color(imagequant::RGBA::new(c.r, c.g, c.b, c.a)).ok()?; }
    let mut res = attr.quantize(&mut image).ok()?;
    res.set_dithering_level(0.0).ok()?;
    res.remapped(&mut image).ok()?; // the remap measures the real error over every pixel
    res.remapping_quality()
}
#[cfg(not(feature = "liq"))]
fn liq_quality_of_palette(_: &Image, _: &[Rgba]) -> Option<u8> { None }

// ---------------------------------------------------------------- PNG output

fn pack_bits(raw: &[u8], w: usize, bits: usize) -> Vec<u8> {
    match bits { 1 => pack_bits_n::<1>(raw, w), 2 => pack_bits_n::<2>(raw, w), _ => pack_bits_n::<4>(raw, w) }
}
/// One output byte per `8 / BITS` indices, most significant first, the last byte of a row padded with zero bits
/// (PNG's order). The depth is a constant, so there is no division per pixel (P45: `i / per` with a runtime
/// `per` was a `udiv` per pixel, next to a reload of `per` and `bits` and a divide-by-zero check).
fn pack_bits_n<const BITS: usize>(raw: &[u8], w: usize) -> Vec<u8> {
    let per = 8 / BITS;
    let bw = w.div_ceil(per) + 1;
    let mut out = vec![0u8; bw * (raw.len() / (w + 1))];
    out.par_chunks_mut(bw).zip(raw.par_chunks(w + 1)).for_each(|(o, r)| {
        for (ob, px) in o[1..].iter_mut().zip(r[1..].chunks(per)) {
            let mut b = 0u8;
            for (j, &v) in px.iter().enumerate() { b |= v << (8 - BITS - j * BITS); }
            *ob = b;
        }
    });
    out
}

fn chunk(out: &mut Vec<u8>, ty: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut h = crc32fast::Hasher::new();
    h.update(ty); h.update(data);
    out.extend_from_slice(ty); out.extend_from_slice(data);
    out.extend_from_slice(&h.finalize().to_be_bytes());
}

/// The zlib level when `--level` is not given (P35, 0.20.0: the owner's choice). Up to 0.19.0 a probe picked 6 for
/// screen content and 5 for noisy content above 1.5 MB of rows (level 9 only below); against that, level 9
/// everywhere is -0.6..-1.9% on the owner's 3200x2068 screenshots for +3..4 ms of the whole process, -2.6..-10.8%
/// on the public screenshots, -5.5% / +9 ms on the 5K desktop, -5.4% / +7 ms on the 5K photo (16 threads; zlib-rs
/// levels 7-8 are not monotone and were no better). The parallel chunks keep the wall-clock cost small.
const LEVEL_DEFAULT: i32 = 9;
/// Rows are compressed in independent chunks (pigz/mtpng style): each chunk is a raw deflate stream primed with the
/// previous 32 KB as dictionary and closed with a sync flush (an empty stored block, byte aligned, BFINAL=0), so the
/// concatenation is one valid deflate stream. Adler-32 is combined from the chunks. Chunks are 1/32 of the rows,
/// 64-256 KB (256 KB chunks cost 0.1% more bytes than one stream; 128 KB 0.3%): the chunking depends only on the
/// data length and the level, never on how many threads run.
fn deflate_chunk(len: usize) -> usize { (len / 32).clamp(64 << 10, 256 << 10) }

fn zlib_parallel(raw: &[u8], level: i32) -> Vec<u8> {
    let mut z = Vec::new();
    zlib_parallel_into(raw, level, &mut z);
    z
}

/// Per-chunk zlib level (P40, default since 0.23.0): zlib-rs level 8 for chunks where it beats level 9. The per-chunk oracle
/// (results/size-study-2026-09-20/chunkbench, HANDOFF P40) found level 8 smaller than 9 on most chunks of the
/// owner's light-UI screenshots (many short runs over few distinct indices) and larger everywhere else; the rule
/// "transitions per byte >= 0.12 and at most 100 distinct indices", both measured on every 8th byte, takes
/// -0.79% on those screenshots (oracle -0.95%) and +0.005% on the other 21 bench images, at the same CPU.
/// `SHOTQ_LEVEL_RULE=0` keeps level 9 for every chunk (the 0.20.0-0.22.0 output).
const LEVEL_RULE: bool = true;
fn level_rule() -> bool {
    static V: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *V.get_or_init(|| std::env::var("SHOTQ_LEVEL_RULE").map_or(LEVEL_RULE, |s| s != "0"))
}
const RULE_STEP: usize = 8;
const RULE_TRANSITIONS: f32 = 0.12;
const RULE_DISTINCT: usize = 100;
fn prefers_level8(input: &[u8]) -> bool {
    let (mut seen, mut trans, mut pairs) = ([false; 256], 0usize, 0usize);
    let mut p = 0;
    while p + 1 < input.len() {
        seen[input[p] as usize] = true;
        if input[p] != input[p + 1] { trans += 1; }
        pairs += 1; p += RULE_STEP;
    }
    pairs > 0 && trans as f32 >= RULE_TRANSITIONS * pairs as f32 && seen.iter().filter(|&&b| b).count() <= RULE_DISTINCT
}

fn zlib_parallel_into(raw: &[u8], level: i32, out: &mut Vec<u8>) {
    let level = flate2::Compression::new(level.clamp(1, 9) as u32);
    let chunk_len = deflate_chunk(raw.len());
    let n = raw.len().div_ceil(chunk_len).max(1);
    let rule = level_rule() && level.level() == 9;
    let n8 = std::sync::atomic::AtomicUsize::new(0);
    // A fresh compressor for every chunk, so that the chunk's bytes are a function of the chunk alone. Reusing a
    // worker's compressor after a reset (P38) made the output depend on the thread count: zlib-rs's reset clears
    // the hash and the positions but not the window bytes, and it has no high-water zeroing, so the matcher could
    // read the worker's previous chunk past the end of the input and pick a different match (one byte on two of
    // the owner's screenshots, level-8 chunks, P40). Removed in 0.23.1 (P44) together with the unused per-worker
    // compressors that 0.23.0 still allocated.
    let parts: Vec<(Vec<u8>, u32)> = (0..n).into_par_iter().map(|i| {
        let (start, end) = (i * chunk_len, ((i + 1) * chunk_len).min(raw.len()));
        let input = &raw[start..end];
        // the requested level, or 8 where the rule prefers it (0.23.0 compressed every other chunk at 9 whatever
        // --level said; fixed in 0.23.1)
        let lvl = if rule && prefers_level8(input) { n8.fetch_add(1, Ordering::Relaxed); 8 } else { level.level() };
        let mut c = flate2::Compress::new_with_window_bits(flate2::Compression::new(lvl), false, 15);
        if start > 0 { c.set_dictionary(&raw[start.saturating_sub(32 << 10)..start]).expect("deflate dictionary"); }
        let mut out = Vec::with_capacity(input.len() / 2 + 1024);
        let mut done = 0usize;
        while done < input.len() {
            if out.capacity() - out.len() < 4096 { out.reserve(out.capacity() / 2 + 4096); }
            let before = c.total_in();
            c.compress_vec(&input[done..], &mut out, flate2::FlushCompress::None).expect("deflate");
            done += (c.total_in() - before) as usize;
        }
        let flush = if end == raw.len() { flate2::FlushCompress::Finish } else { flate2::FlushCompress::Sync };
        loop {
            if out.capacity() - out.len() < 4096 { out.reserve(out.capacity() / 2 + 4096); }
            let spare = out.capacity() - out.len();
            let status = c.compress_vec(&[], &mut out, flush).expect("deflate flush");
            // Finish is complete at StreamEnd; a sync flush is complete once a call leaves output space unused.
            if status == flate2::Status::StreamEnd || (flush == flate2::FlushCompress::Sync && out.capacity() - out.len() < spare && out.capacity() > out.len()) { break; }
        }
        (out, simd_adler32::adler32(&input))
    }).collect();
    if rule && std::env::var_os("SHOTQ_DEBUG").is_some() { eprintln!("  deflate: level rule chose level 8 for {} of {n} chunks", n8.load(Ordering::Relaxed)); }
    zlib_join(&parts, chunk_len, raw.len(), out);
}

/// Appends the zlib stream (header, the fragments, the combined Adler-32) to `out`.
fn zlib_join(parts: &[(Vec<u8>, u32)], chunk_len: usize, raw_len: usize, out: &mut Vec<u8>) {
    out.reserve(parts.iter().map(|p| p.0.len()).sum::<usize>() + 6);
    out.extend_from_slice(&[0x78, 0xDA]); // CMF: deflate, 32 KB window; FLG: max compression hint, check bits valid
    let mut adler = 1u32;
    for (i, (part, a)) in parts.iter().enumerate() {
        out.extend_from_slice(part);
        let len = (((i + 1) * chunk_len).min(raw_len) - i * chunk_len) as u32;
        adler = if i == 0 { *a } else { adler32_combine(adler, *a, len) };
    }
    out.extend_from_slice(&adler.to_be_bytes());
}

/// Adler-32 of the concatenation of two buffers from their separate checksums (zlib's adler32_combine).
// Adapted from zlib's adler32.c, adler32_combine_.
// Original code: Copyright (C) 1995-2011, 2016 Mark Adler.
// Modified for shotq: translated to Rust with a u32 length parameter.
// The adapted portion is distributed under the zlib license.
// See LICENSES/zlib.txt and THIRD_PARTY_NOTICES.md.
fn adler32_combine(a1: u32, a2: u32, len2: u32) -> u32 {
    const BASE: u32 = 65521;
    let rem = len2 % BASE;
    let mut sum1 = a1 & 0xffff;
    let mut sum2 = rem * sum1 % BASE;
    sum1 += (a2 & 0xffff) + BASE - 1;
    sum2 += ((a1 >> 16) & 0xffff) + ((a2 >> 16) & 0xffff) + BASE - rem;
    if sum1 >= BASE { sum1 -= BASE; }
    if sum1 >= BASE { sum1 -= BASE; }
    if sum2 >= BASE << 1 { sum2 -= BASE << 1; }
    if sum2 >= BASE { sum2 -= BASE; }
    sum1 | (sum2 << 16)
}

/// `colour` holds the colour chunks (sRGB + gAMA, or an iCCP) to write between IHDR and PLTE; empty for an untagged input.
fn encode_indexed(w: usize, h: usize, pal: &[Rgba], raw: Vec<u8>, level: Option<i32>, colour: &[u8]) -> Vec<u8> {
    let bits = match pal.len() { 0..=2 => 1, 3..=4 => 2, 5..=16 => 4, _ => 8 };
    let raw = if bits < 8 { pack_bits(&raw, w, bits) } else { raw };
    let level = level.unwrap_or(LEVEL_DEFAULT);
    // SHOTQ_DEFLATE=libdeflate (size-plan.md phase 1, experiment): libdeflate in row-aligned chunks joined into one
    // stream; the level comes from SHOTQ_DEFLATE_LEVEL (default 9), not from --level. Only for images
    // whose rows fill 1.5 MB or more: below that zlib-rs level 9 with its
    // 32 KB dictionary between chunks is smaller (libdeflate has no dictionary; on 64 KB chunks that cost 5-14%).
    let mut out = Vec::with_capacity(1200);
    out.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    let mut ihdr = [0u8; 13];
    ihdr[..4].copy_from_slice(&(w as u32).to_be_bytes());
    ihdr[4..8].copy_from_slice(&(h as u32).to_be_bytes());
    ihdr[8] = bits as u8; ihdr[9] = 3;
    chunk(&mut out, b"IHDR", &ihdr);
    out.extend_from_slice(colour);
    let plte: Vec<u8> = pal.iter().flat_map(|c| [c.r, c.g, c.b]).collect();
    chunk(&mut out, b"PLTE", &plte);
    if let Some(n) = pal.iter().rposition(|c| c.a < 255) {
        let t: Vec<u8> = pal[..=n].iter().map(|c| c.a).collect();
        chunk(&mut out, b"tRNS", &t);
    }
    // the IDAT is assembled in place (P38): length field, type, the deflate fragments, then the CRC over type + data;
    // the fragments are copied once instead of into a stream buffer and again into the file
    let at = out.len();
    out.extend_from_slice(&[0, 0, 0, 0, b'I', b'D', b'A', b'T']);
    match deflate::backend() {
        deflate::Backend::Libdeflate(lvl) if raw.len() >= (3 << 19) => out.extend_from_slice(&deflate::libdeflate_parallel(&raw, lvl, raw.len() / h)),
        _ => zlib_parallel_into(&raw, level, &mut out),
    }
    let n = out.len() - at - 8;
    out[at..at + 4].copy_from_slice(&(n as u32).to_be_bytes());
    let crc = crc32fast::hash(&out[at + 4..]);
    out.extend_from_slice(&crc.to_be_bytes());
    chunk(&mut out, b"IEND", &[]);
    out
}

/// Only used when the input was not a PNG and the quality floor could not be met. The pixels are written as they
/// are, so the input's colour tag is restated (an sRGB BMP gets sRGB + gAMA, an embedded profile its own iCCP).
fn encode_truecolor(img: &Image) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let opaque = img.rgba.par_chunks(4 << 16).all(|c| c.chunks_exact(4).all(|p| p[3] == 255));
    let mut enc = png::Encoder::new(&mut out, img.w as u32, img.h as u32);
    enc.set_depth(png::BitDepth::Eight);
    enc.set_compression(png::Compression::Fast);
    if opaque {
        enc.set_color(png::ColorType::Rgb);
        let rgb: Vec<u8> = img.rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
        enc.write_header().and_then(|mut w| w.write_image_data(&rgb)).map_err(|e| e.to_string())?;
    } else {
        enc.set_color(png::ColorType::Rgba);
        enc.write_header().and_then(|mut w| w.write_image_data(&img.rgba)).map_err(|e| e.to_string())?;
    }
    let tag = cm::passthrough_chunks(&img.colour);
    if !tag.is_empty() { out.splice(33..33, tag); } // after the signature (8) and IHDR (25)
    Ok(out)
}

fn colour_note(t: &cm::Tagged) -> String { if t.note.is_empty() { String::new() } else { format!(", {}", t.note) } }

// ---------------------------------------------------------------- optimize

/// How a run ended. The exit codes keep pngquant's meaning.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// The optimized PNG is smaller than a PNG input (or the input was a BMP). Exit code 0.
    Optimized,
    /// The palette could not reach `qmin`: a PNG input is kept, a BMP input becomes a lossless truecolor PNG. Exit code 99.
    QualityTooLow,
    /// The optimized PNG was not smaller than the PNG input, which is kept. Exit code 98.
    NotSmaller,
}

impl Status {
    pub fn exit_code(self) -> i32 { match self { Status::Optimized => 0, Status::QualityTooLow => 99, Status::NotSmaller => 98 } }
}

/// The result of `optimize`.
#[derive(Debug)]
pub struct Outcome {
    pub status: Status,
    /// The bytes the output must hold, or None when the input bytes are to be kept as they are (a PNG input that
    /// was not improved). Never larger than a PNG input.
    pub png: Option<Vec<u8>>,
    pub width: usize,
    pub height: usize,
    /// What was done, as the CLI's `--timing` line shows it (colours, quality, colour tag)
    pub note: String,
    /// Milliseconds per stage, in order
    pub stages: Vec<(&'static str, f64)>,
}

/// The largest image accepted, in pixels; larger inputs are refused with an error.
pub const MAX_INPUT_PIXELS: usize = MAX_PIXELS;

/// Optimizes one PNG or uncompressed 24/32-bit BMP held in memory. Runs on the current rayon pool (call it inside
/// `ThreadPool::install` to bound the threads); the output bytes do not depend on the number of threads. Reads
/// no files and writes nothing: the caller writes `Outcome::png`, atomically, or keeps the input.
pub fn optimize(data: &[u8], o: &Options) -> Result<Outcome, String> {
    if o.qmin > o.qmax || o.qmax > 100 { return Err("bad --quality range".into()); }
    // the CLI's clamping, for callers that fill `Options` themselves (a no-op for the CLI)
    let o = &Options { speed: o.speed.clamp(1, 11), level: o.level.map(|l| l.clamp(1, 9)), dither: o.dither.clamp(0.0, 1.0), ..o.clone() };
    let mut marks: Vec<(&'static str, f64)> = Vec::new();
    let mut t = Instant::now();
    let mut mark = |name: &'static str, t: &mut Instant| { marks.push((name, t.elapsed().as_secs_f64() * 1e3)); *t = Instant::now(); };

    let img = load(data)?;
    mark("decode", &mut t);

    let mut code = 0;
    let note;
    let result: Option<Vec<u8>> = if let Some((pal, raw)) = try_exact(&img) {
        mark("exact", &mut t);
        let tagged = cm::to_srgb(&img.colour, &pal);
        note = format!("{} colours, {}{}", pal.len(), if img.depth16 { "16-bit input reduced to 8-bit" } else { "lossless" }, colour_note(&tagged));
        let out = encode_indexed(img.w, img.h, &tagged.pal, raw, o.level, &tagged.chunks);
        mark("deflate", &mut t);
        Some(out)
    } else {
        mark("exact?", &mut t);
        let space = ColorSpace::new();
        match build_palette(&img, o, &space) {
            Ok(Built { mut pal, quality: q, cells, info, locked }) => {
                mark("quantize", &mut t);
                // The remap uses `pal` in the input's colour space; only the written PLTE is converted to sRGB.
                // Without dithering the remap also returns per-entry pixel statistics, and the palette is corrected
                // to them before it is written (P20; dithered indices were chosen against the original colours and
                // stay with them).
                let raw = if o.dither > 0.0 { (remap_dithered(&img, &pal, &space, &cells, o.dither), Vec::new()) } else {
                    let eps = (hyst() * quant::quality_to_mse(o.qmax)) as f32;
                    // P42 (default since 0.22.0): the remap writes the plain assignment, the runs are merged after the
                    // correction against the corrected palette (`merge_runs`); SHOTQ_MERGE_LATE=0 merges in the remap
                    let late = merge_late();
                    let (mut raw, stats) = match (lut_proof(), late) {
                        (false, true) => remap::<false, false>(&img, &pal, &space, &cells, 0.0),
                        (false, false) => remap::<false, true>(&img, &pal, &space, &cells, eps),
                        (true, true) => remap::<true, false>(&img, &pal, &space, &cells, 0.0),
                        (true, false) => remap::<true, true>(&img, &pal, &space, &cells, eps),
                    };
                    // SHOTQ_P20=0 (P39, diagnostics): skip the correction, so that tools see the design palette
                    let (moved, worst) = if std::env::var("SHOTQ_P20").map_or(true, |v| v != "0") { correct_palette(&mut pal, &stats, &locked) } else { (0, 0) };
                    if std::env::var_os("SHOTQ_DEBUG").is_some() {
                        eprintln!("  remap: palette correction moved {moved} entries, at most {worst} levels");
                        eprintln!("  remap: locked entries {:?}", locked.iter().enumerate().filter(|(_, &l)| l).map(|(i, _)| i).collect::<Vec<_>>());
                    }
                    if late {
                        let tm = Instant::now();
                        let (n, runs, tests) = merge_runs(&img, &pal, &space, &mut raw, eps);
                        if std::env::var_os("SHOTQ_DEBUG").is_some() { eprintln!("  remap: late run merging moved {n} pixels against the corrected palette in {:.2} ms ({runs} runs, {tests} colour tests)", tm.elapsed().as_secs_f64() * 1e3); }
                    }
                    (raw, stats)
                };
                mark("remap", &mut t);
                // The edge sub-palette (P34) runs on the corrected palette and moves only anti-aliasing pixels; the
                // palette itself does not change after this point (size-plan.md 9.8).
                let raw = if o.dither <= 0.0 && subpal::enabled() {
                    let (mut raw, stats) = raw;
                    let rep = subpal::apply(img.w, img.h, &img.rgba, &pal, &stats, &space, &mut raw);
                    if std::env::var_os("SHOTQ_DEBUG").is_some() { eprintln!("  subpal: {} of {} entries kept, {} pixels moved, {} reverted in {} windows; {} runs cross a window boundary, {} of them partly reverted", rep.kept, rep.kept + rep.dropped, rep.changed, rep.reverted, rep.windows, rep.split_runs, rep.partial_runs); }
                    mark("subpal", &mut t);
                    raw
                } else { raw.0 };
                let tagged = cm::to_srgb(&img.colour, &pal);
                if std::env::var_os("SHOTQ_CHECK_QUALITY").is_some() { check_quality(&img, &pal, &raw, &space, q); }
                if std::env::var_os("SHOTQ_DEBUG").is_some() && !tagged.note.is_empty() { eprintln!("  colour: {}", tagged.note); }
                let out = encode_indexed(img.w, img.h, &tagged.pal, raw, o.level, &tagged.chunks);
                mark("deflate", &mut t);
                note = format!("{} colours, quality {}, {}{}{}{}", pal.len(), q.map_or("?".into(), |q| q.to_string()), info, if o.dither > 0.0 { ", dithered" } else { "" }, if img.depth16 { ", 16-bit input reduced to 8-bit" } else { "" }, colour_note(&tagged));
                Some(out)
            }
            Err(BuildErr::QualityTooLow) => {
                code = 99;
                note = format!("quality below {}: kept lossless", o.qmin);
                if img.is_png { None } else { Some(encode_truecolor(&img)?) }
            }
            Err(BuildErr::Other(e)) => return Err(e),
        }
    };
    let (status, png) = match result {
        Some(out) if !img.is_png || out.len() < data.len() => (if code == 99 { Status::QualityTooLow } else { Status::Optimized }, Some(out)),
        Some(_) => (Status::NotSmaller, None),
        None => (Status::QualityTooLow, None),
    };
    Ok(Outcome { status, png, width: img.w, height: img.h, note, stages: marks })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_rgb(w: usize, h: usize, pixels: &[u8]) -> Vec<u8> {
        let mut file = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut file, w as u32, h as u32);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Eight);
            enc.write_header().unwrap().write_image_data(pixels).unwrap();
        }
        file
    }

    /// The library entry point: the status follows the CLI's exit codes, `png` is None exactly when the input is to
    /// be kept, the output does not depend on the thread count, and out-of-range options are clamped as the CLI does.
    #[test]
    fn optimize_reports_like_the_cli() {
        // a noisy photo-like image: far more than 256 colours, so the quantizer runs
        let (w, h) = (256usize, 96usize);
        let mut x = 1u32;
        let pixels: Vec<u8> = (0..w * h * 3).map(|i| {
            x = x.wrapping_mul(1664525).wrapping_add(1013904223);
            ((i / 3 % w) as u32 + (i / (w * 3)) as u32 + (x >> 29)) as u8
        }).collect();
        let input = png_rgb(w, h, &pixels);
        let o = Options { speed: 11, ..Options::default() };
        let out = optimize(&input, &o).unwrap();
        assert_eq!(out.status, Status::Optimized);
        assert_eq!((out.width, out.height), (w, h));
        let png = out.png.as_deref().unwrap();
        assert!(png.len() < input.len());
        assert_eq!(load_png(png).unwrap().w, w);

        let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
        let serial = pool.install(|| optimize(&input, &o).unwrap());
        assert_eq!(serial.png, out.png, "thread count changed the output");

        let clamped = optimize(&input, &Options { speed: 99, level: Some(0), dither: -1.0, ..Options::default() }).unwrap();
        let cli = optimize(&input, &Options { speed: 11, level: Some(1), dither: 0.0, ..Options::default() }).unwrap();
        assert_eq!(clamped.png, cli.png);

        // quality floor out of reach: a PNG input is kept
        let floor = optimize(&input, &Options { qmin: 100, qmax: 100, ..o.clone() }).unwrap();
        assert_eq!((floor.status, floor.status.exit_code(), floor.png.is_none()), (Status::QualityTooLow, 99, true));

        // one colour, already tiny: not smaller, the input is kept
        let tiny = png_rgb(1, 1, &[10, 20, 30]);
        let kept = optimize(&tiny, &o).unwrap();
        assert_eq!((kept.status, kept.status.exit_code(), kept.png.is_none()), (Status::NotSmaller, 98, true));

        assert!(optimize(&input, &Options { qmin: 90, qmax: 80, ..o.clone() }).is_err());
        assert!(optimize(b"not an image", &o).is_err());
    }

    /// Run merging (P33): with a tolerance no transition is created, every moved pixel stays within the tolerance
    /// of its own entry, exact palette colours never move, the statistics follow the written entries, and the
    /// result does not depend on the thread count.
    #[test]
    fn run_merging_only_removes_transitions_within_the_tolerance() {
        let (w, h) = (300usize, 24usize);
        let mut rgba = vec![0u8; w * h * 4];
        let mut x = 7u32;
        for y in 0..h { for i in 0..w {
            x = x.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = (x >> 30) as i32 - 1;                       // -1, 0, 0, 1
            let g = if y < 8 { (i * 255 / w) as i32 + noise }        // a grey ramp with +-1 noise
                    else if y < 16 { if i % 40 < 20 { 200 } else { 60 } } // flat panels of exact palette colours
                    else { (if (i / 3) % 2 == 0 { 30 } else { 230 }) + noise * 3 }; // text-like edges
            let g = g.clamp(0, 255) as u8;
            let p = &mut rgba[(y * w + i) * 4..(y * w + i) * 4 + 4];
            p[0] = g; p[1] = g; p[2] = g; p[3] = 255;
        } }
        let img = Image { w, h, rgba, is_png: true, depth16: false, colour: cm::Colour::None };
        let space = ColorSpace::new();
        let pal: Vec<Rgba> = (0..64).map(|k| { let g = (k * 4) as u8; Rgba { r: g, g, b: g, a: 255 } }).collect(); // greys 0, 4, ..., 252 (200 and 60 are entries)
        let eps = (0.1 * quant::quality_to_mse(85)) as f32;
        let (base, st0) = remap::<false, false>(&img, &pal, &space, &[], 0.0);
        // the merging instantiation with a zero tolerance is the plain one, bytes and statistics (P44)
        let (base_m, st0_m) = remap::<false, true>(&img, &pal, &space, &[], 0.0);
        assert!(base_m == base && st0_m == st0, "MERGE with eps 0 differs from the plain remap");
        let (merged, st1) = remap::<false, true>(&img, &pal, &space, &[], eps);
        let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
        let (merged1, st11) = pool.install(|| remap::<false, true>(&img, &pal, &space, &[], eps));
        assert!(merged == merged1 && st1 == st11, "thread count changed the merged output");
        let trans = |raw: &[u8]| (0..h).map(|y| (2..=w).filter(|&i| raw[y * (w + 1) + i] != raw[y * (w + 1) + i - 1]).count()).collect::<Vec<_>>();
        let (t0, t1) = (trans(&base), trans(&merged));
        assert!(t1.iter().zip(&t0).all(|(a, b)| a <= b), "a row gained transitions: {t0:?} -> {t1:?}");
        assert!(t1.iter().sum::<usize>() < t0.iter().sum::<usize>(), "nothing merged on the noisy ramp");
        let mut moved = 0;
        for y in 0..h { for i in 0..w {
            let (a, b) = (base[y * (w + 1) + 1 + i] as usize, merged[y * (w + 1) + 1 + i] as usize);
            if a == b { continue; }
            moved += 1;
            let p = &img.rgba[(y * w + i) * 4..(y * w + i) * 4 + 4];
            let c = space.conv(p[0], p[1], p[2], p[3]);
            let (da, db) = (color::diff(&c, &space.conv(pal[a].r, pal[a].g, pal[a].b, 255)), color::diff(&c, &space.conv(pal[b].r, pal[b].g, pal[b].b, 255)));
            assert!(db <= da + eps * 1.001, "pixel ({i},{y}) moved beyond the tolerance: {da} -> {db}");
            assert!(da > 0.0, "an exact palette colour was moved");
        } }
        assert!(moved > 0);
        assert!((8..16).all(|y| (0..w).all(|i| base[y * (w + 1) + 1 + i] == merged[y * (w + 1) + 1 + i])), "flat panels changed");
        // the statistics count every opaque pixel under the entry it was written with
        for (raw, st) in [(&base, &st0), (&merged, &st1)] {
            let mut cnt = vec![0u64; pal.len()];
            for y in 0..h { for i in 0..w { cnt[raw[y * (w + 1) + 1 + i] as usize] += 1; } }
            assert!(st.iter().map(|s| s[0]).eq(cnt.iter().copied()), "statistics do not follow the written entries");
        }
    }

    /// The late run merging (P42, order variant V-2) holds P33's admission test against the palette it is measured
    /// on, which is the palette that gets written: after `correct_palette` moved entries, every merged pixel is
    /// within eps of its new entry under the corrected palette and was not an exact colour, no row gains a
    /// transition, the first run of a row and the flat panels stay, the thread count does not matter, and on a
    /// palette that did not move the pass equals the in-remap merging byte for byte.
    #[test]
    fn late_run_merging_holds_the_tolerance_on_the_corrected_palette() {
        let (w, h) = (301usize, 32usize); // 301: the index row's tail is not a multiple of 8 (P45)
        let mut rgba = vec![0u8; w * h * 4];
        let mut x = 7u32;
        for y in 0..h { for i in 0..w {
            x = x.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = (x >> 30) as i32 - 1;
            let g = if y < 8 { (i * 255 / w) as i32 + noise } else if y < 16 { if i % 40 < 20 { 200 } else { 60 } } else if y < 24 { (if (i / 3) % 2 == 0 { 30 } else { 230 }) + noise * 3 } else {
                // Long runs for the chunked scans of `merge_runs` (P45). 84 takes entry 83; 82 lies between 81 and
                // 83 (nearer 81 in the curved space, within eps of 83); 81 is an exact entry.
                match y % 4 {
                    0 => if i < 5 { 84 } else { 82 },                                                   // one run to the row end, merged after one test
                    1 => if i < 5 { 84 } else { 82 },                                                   // 82 and (82, 82, 81) in blocks of 10: chunk mismatches mid-run
                    2 => if i < 5 { 84 } else if i == 25 { 81 } else if i < 46 { 82 } else { 84 },       // an exact colour after 20 skipped pixels: rejected
                    _ => 82,                                                                            // a row of one colour: the first run, never admitted
                }
            };
            let g = g.clamp(0, 255) as u8;
            let b = if y >= 24 && y % 4 == 1 && i >= 5 && (i - 5) / 10 % 2 == 1 { g - 1 } else { g };
            let p = &mut rgba[(y * w + i) * 4..(y * w + i) * 4 + 4];
            p[0] = g; p[1] = g; p[2] = b; p[3] = 255;
        } }
        let img = Image { w, h, rgba, is_png: true, depth16: false, colour: cm::Colour::None };
        let space = ColorSpace::new();
        // greys 4k + (k mod 3) - 1: off the ramp's means, so the correction moves them; 60 and 200 exact and locked
        let mut pal: Vec<Rgba> = (0..64).map(|k| { let g = ((k * 4) as i32 + (k % 3) as i32 - 1).clamp(0, 255) as u8; Rgba { r: g, g, b: g, a: 255 } }).collect();
        pal[15] = Rgba { r: 60, g: 60, b: 60, a: 255 }; pal[50] = Rgba { r: 200, g: 200, b: 200, a: 255 };
        let mut locked = vec![false; pal.len()]; locked[15] = true; locked[50] = true;
        let eps = (0.1 * quant::quality_to_mse(85)) as f32;
        let (plain, stats) = remap::<false, false>(&img, &pal, &space, &[], 0.0);
        // a fixed palette: the late pass is the in-remap merging
        let (inpass, _) = remap::<false, true>(&img, &pal, &space, &[], eps);
        let mut late0 = plain.clone(); merge_runs(&img, &pal, &space, &mut late0, eps);
        assert!(late0 == inpass, "the late pass differs from the in-remap merging on a fixed palette");
        // the long runs (P45): the run of 82 merges into 83's entry up to the row end; the run holding an exact
        // colour and a row's first run stay
        let row = |raw: &[u8], y: usize| raw[y * (w + 1) + 1..(y + 1) * (w + 1)].to_vec();
        assert!(row(&plain, 24)[5] != row(&plain, 24)[0] && row(&late0, 24)[5..].iter().all(|&v| v == row(&late0, 24)[0]), "the long run did not merge");
        assert!(row(&late0, 26) == row(&plain, 26), "the run holding an exact colour moved");
        assert!(row(&late0, 27) == row(&plain, 27), "a row's first run moved");
        // the corrected palette
        let mut pal1 = pal.clone();
        let (moved, _) = correct_palette(&mut pal1, &stats, &locked);
        assert!(moved > 0, "the correction moved nothing");
        let mut late = plain.clone(); let (n, _, _) = merge_runs(&img, &pal1, &space, &mut late, eps);
        assert!(n > 0, "nothing merged");
        let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
        let mut late1 = plain.clone(); pool.install(|| merge_runs(&img, &pal1, &space, &mut late1, eps));
        assert!(late == late1, "thread count changed the merged output");
        let trans = |raw: &[u8]| (0..h).map(|y| (2..=w).filter(|&i| raw[y * (w + 1) + i] != raw[y * (w + 1) + i - 1]).count()).collect::<Vec<_>>();
        let (t0, t1) = (trans(&plain), trans(&late));
        assert!(t1.iter().zip(&t0).all(|(a, b)| a <= b), "a row gained transitions: {t0:?} -> {t1:?}");
        for y in 0..h {
            let first = plain[y * (w + 1) + 1];
            let end = (0..w).find(|&i| plain[y * (w + 1) + 1 + i] != first).unwrap_or(w);
            assert!((0..end).all(|i| late[y * (w + 1) + 1 + i] == first), "the first run of row {y} moved");
        }
        let conv = |c: Rgba| space.conv(c.r, c.g, c.b, 255);
        for y in 0..h { for i in 0..w {
            let (a, b) = (plain[y * (w + 1) + 1 + i] as usize, late[y * (w + 1) + 1 + i] as usize);
            if a == b { continue; }
            let p = &img.rgba[(y * w + i) * 4..(y * w + i) * 4 + 4];
            let c = space.conv(p[0], p[1], p[2], p[3]);
            let (da, db) = (color::diff(&c, &conv(pal1[a])), color::diff(&c, &conv(pal1[b])));
            assert!(db <= da + eps * 1.001, "pixel ({i},{y}) moved beyond the tolerance on the corrected palette: {da} -> {db}");
            assert!(da > 0.0, "an exact colour was moved");
        } }
        assert!((8..16).all(|y| (0..w).all(|i| plain[y * (w + 1) + 1 + i] == late[y * (w + 1) + 1 + i])), "flat panels changed");
    }

    /// The proof table (P43) must give every opaque pixel its exact nearest entry (ties to the lower index), also
    /// when the cell table was pre-filled with wrong answers (the design's cell answers are not exact for every
    /// colour of a cell), the plain table must NOT be exact on the same image (so the test bites), and the thread
    /// count must not matter.
    #[test]
    fn proof_table_matches_the_exact_nearest_entry() {
        let (w, h) = (360usize, 160usize);
        let mut x = 99u32;
        let mut lcg = move || { x = x.wrapping_mul(1664525).wrapping_add(1013904223); x >> 8 };
        let pal: Vec<Rgba> = (0..200).map(|_| Rgba { r: (lcg() & 255) as u8, g: (lcg() & 255) as u8, b: (lcg() & 255) as u8, a: 255 }).collect();
        let mut rgba = vec![0u8; w * h * 4];
        for y in 0..h { for i in 0..w {
            let n = (lcg() % 7) as i32 - 3;
            let p = &mut rgba[(y * w + i) * 4..(y * w + i) * 4 + 4];
            p[0] = ((i * 255 / w) as i32 + n).clamp(0, 255) as u8; p[1] = ((y * 255 / h) as i32 - n).clamp(0, 255) as u8; p[2] = (((i + y) * 3) % 256) as u8; p[3] = 255;
        } }
        let img = Image { w, h, rgba, is_png: true, depth16: false, colour: cm::Colour::None };
        let space = ColorSpace::new();
        let pf = quant::Searcher::new(&space, &pal);
        let exact = |p: &[u8]| -> usize {
            let v = space.conv(p[0], p[1], p[2], p[3]);
            (0..pal.len()).fold((0usize, f32::MAX), |b, j| { let d = pf.dist(&v, j); if d < b.1 { (j, d) } else { b } }).0
        };
        // wrong pre-filled answers for every cell the image touches: entry (cell index mod 200)
        let mut cells: Vec<(u32, u16)> = (0..w * h).map(|i| { let p = &img.rgba[i * 4..i * 4 + 4]; let c = cell(p[0], p[1], p[2]); (c as u32, (c % 200) as u16) }).collect();
        cells.sort_unstable(); cells.dedup();
        for (tag, cs) in [("empty cells", &Vec::new()), ("wrong pre-filled cells", &cells)] {
            let (raw, _) = remap::<true, false>(&img, &pal, &space, cs, 0.0);
            for y in 0..h { for i in 0..w {
                let p = &img.rgba[(y * w + i) * 4..(y * w + i) * 4 + 4];
                assert_eq!(raw[y * (w + 1) + 1 + i] as usize, exact(p), "{tag}: pixel ({i},{y}) is not at its nearest entry");
            } }
            let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
            let (raw1, _) = pool.install(|| remap::<true, false>(&img, &pal, &space, cs, 0.0));
            assert!(raw == raw1, "{tag}: thread count changed the output");
        }
        let (plain, _) = remap::<false, false>(&img, &pal, &space, &[], 0.0);
        let wrong = (0..h).flat_map(|y| (0..w).map(move |i| (y, i))).filter(|&(y, i)| plain[y * (w + 1) + 1 + i] as usize != exact(&img.rgba[(y * w + i) * 4..(y * w + i) * 4 + 4])).count();
        assert!(wrong > 0, "the plain cell table is exact on this image: the test does not bite");
    }

    /// The row-skewed parallel Floyd-Steinberg must give exactly what a serial pass with the same per-pixel lookup
    /// and the same gate gives, on an image with a gradient, noise, translucent and transparent pixels, flat bands
    /// and a flat block (not dithered), and a smooth banded gradient (dithered).
    #[test]
    fn parallel_dithering_matches_serial_reference() {
        let (w, h) = (301usize, 97usize);
        let mut seed = 5u32;
        let mut lcg = move || { seed = seed.wrapping_mul(1664525).wrapping_add(1013904223); seed >> 8 };
        let mut rgba = vec![0u8; w * h * 4];
        for y in 0..h { for x in 0..w {
            let i = (y * w + x) * 4;
            let n = (lcg() % 9) as i32 - 4;
            rgba[i] = ((x * 255 / w) as i32 + n).clamp(0, 255) as u8; rgba[i + 1] = ((y * 255 / h) as i32 - n).clamp(0, 255) as u8; rgba[i + 2] = 128;
            rgba[i + 3] = match lcg() % 10 { 0 => 0, 1 => (lcg() % 256) as u8, _ => 255 };
            if (40..48).contains(&y) { rgba[i..i + 4].copy_from_slice(&[100, 100, 100, 255]); }                    // flat band
            if (120..180).contains(&x) && (50..90).contains(&y) { rgba[i..i + 4].copy_from_slice(&[200, 50, 50, 255]); } // flat block
            if (200..290).contains(&x) && (10..38).contains(&y) { let g = 60 + ((x - 200) / 6) as u8; rgba[i..i + 4].copy_from_slice(&[g, g, g + 20, 255]); } // banded gradient
        } }
        let img = Image { w, h, rgba, is_png: true, depth16: false, colour: cm::Colour::None };
        let pal: Vec<Rgba> = [(0, 0, 0, 0), (0, 0, 128, 255), (64, 64, 128, 255), (128, 128, 128, 255), (192, 192, 128, 255), (255, 255, 128, 255), (255, 0, 128, 255), (0, 255, 128, 255), (128, 128, 128, 128)]
            .iter().map(|&(r, g, b, a)| Rgba { r, g, b, a }).collect();
        let space = ColorSpace::new();
        let parallel = remap_dithered(&img, &pal, &space, &[], 1.0);
        // serial reference with a full-image error buffer
        let pf = quant::Searcher::new(&space, &pal);
        let (lut, fine) = (build_lut(&pal, &[], pf.same_metric_as_design()), fine_table());
        let mut cache = vec![(0u32, EMPTY); 4096];
        let mut err = vec![[0i32; 4]; (w + 2) * (h + 1)]; // [y][x+1], one spare column each side
        let mut serial = vec![0u8; (w + 1) * h];
        let palc: Vec<[i32; 4]> = pal.iter().map(|c| [c.r as i32, c.g as i32, c.b as i32, c.a as i32]).collect();
        let mut gate = vec![0u8; w];
        for y in 0..h { let mut last = 0u16; dither_gate(&img, y, &mut gate); for x in 0..w {
            let p = &img.rgba[(y * w + x) * 4..][..4];
            let dither = gate[x] != 0 && p[3] != 0;
            let mut v = [p[0], p[1], p[2], p[3]];
            if dither { for k in 0..4 { v[k] = (p[k] as i32 + ((err[y * (w + 2) + x + 1][k] + 8) >> 4)).clamp(0, 255) as u8; } }
            let idx = palette_index::<false>(v, last, &lut, &[], &fine, &pf, &space, &mut cache, &mut ProofLocal::default()); last = idx;
            serial[y * (w + 1) + 1 + x] = idx as u8;
            if dither { let c = palc[idx as usize]; for k in 0..4 {
                let e = (v[k] as i32 - c[k]).clamp(-16, 16);
                err[y * (w + 2) + x + 2][k] += e * 7; err[(y + 1) * (w + 2) + x][k] += e * 3; err[(y + 1) * (w + 2) + x + 1][k] += e * 5; err[(y + 1) * (w + 2) + x + 2][k] += e;
            } }
        } }
        assert!(parallel == serial, "parallel dithering differs from the serial reference");
        // the gate must switch the flat band and block off and the banded gradient on
        dither_gate(&img, 44, &mut gate); assert!(gate.iter().all(|&g| g == 0), "flat band is dithered");
        dither_gate(&img, 70, &mut gate); assert!(gate[125..175].iter().all(|&g| g == 0), "flat block is dithered");
        dither_gate(&img, 20, &mut gate); assert!(gate[205..285].iter().all(|&g| g == 1), "banded gradient is not dithered");
    }

    /// The own PNG reader must produce exactly what the png crate produces, for every filter type and colour type,
    /// with widths that give the wavefront strips odd boundaries.
    #[test]
    fn fast_png_reader_matches_png_crate() {
        let mut seed = 11u32;
        let mut lcg = move || { seed = seed.wrapping_mul(1664525).wrapping_add(1013904223); (seed >> 24) as u8 };
        for (w, h, flat) in [(1usize, 1usize, false), (2, 3, false), (7, 5, false), (37, 11, false), (300, 9, false), (101, 40, false), (300, 9, true), (101, 40, true), (64, 64, true)] {
            for ct in [png::ColorType::Grayscale, png::ColorType::Rgb, png::ColorType::Indexed, png::ColorType::GrayscaleAlpha, png::ColorType::Rgba] {
                for filter in [png::Filter::NoFilter, png::Filter::Sub, png::Filter::Up, png::Filter::Avg, png::Filter::Paeth, png::Filter::Adaptive] {
                    let bpp = ct.samples();
                    // smooth-ish data with noise so that every filter is exercised and indices stay in range; the flat
                    // pattern (panels with sparse noise and repeated rows) exercises the zero-run copy of the Paeth rows
                    let pixels: Vec<u8> = if flat { (0..w * h * bpp).map(|i| if lcg() < 12 { lcg() } else if (i / (w * bpp)) % 7 == 3 { 40 } else { 100 }).collect() }
                                          else { (0..w * h * bpp).map(|i| ((i % (w * bpp)) as u8).wrapping_add(lcg() & 7)).collect() };
                    let mut file = Vec::new();
                    {
                        let mut enc = png::Encoder::new(&mut file, w as u32, h as u32);
                        enc.set_color(ct);
                        enc.set_depth(png::BitDepth::Eight);
                        enc.set_filter(filter);
                        if ct == png::ColorType::Indexed {
                            let pal: Vec<u8> = (0..256 * 3).map(|_| lcg()).collect();
                            let trns: Vec<u8> = (0..100).map(|_| lcg()).collect();
                            enc.set_palette(pal);
                            enc.set_trns(trns);
                        }
                        enc.write_header().unwrap().write_image_data(&pixels).unwrap();
                    }
                    let fast = load_png_fast(&file).unwrap_or_else(|| panic!("fast path refused {ct:?} {filter:?} {w}x{h}"));
                    let slow = load_png(&file).unwrap();
                    assert_eq!((fast.w, fast.h), (slow.w, slow.h));
                    assert!(fast.rgba == slow.rgba, "{ct:?} {filter:?} {w}x{h}: decoded pixels differ");
                }
            }
        }
        // a transparent colour (tRNS) on a greyscale or RGB image must be refused: the fast reader has no code for
        // it, and with 1 thread the png crate would otherwise decode the same file differently
        for (ct, trns) in [(png::ColorType::Grayscale, vec![0u8, 7]), (png::ColorType::Rgb, vec![0u8, 7, 0, 7, 0, 7])] {
            let bpp = ct.samples();
            let pixels: Vec<u8> = (0..8 * 4).flat_map(|i| std::iter::repeat(if i % 3 == 0 { 7 } else { 100 }).take(bpp)).collect();
            let mut file = Vec::new();
            {
                let mut enc = png::Encoder::new(&mut file, 8, 4);
                enc.set_color(ct); enc.set_depth(png::BitDepth::Eight); enc.set_trns(trns);
                enc.write_header().unwrap().write_image_data(&pixels).unwrap();
            }
            assert!(load_png_fast(&file).is_none(), "{ct:?} with tRNS must go through the png crate");
            let img = load_png(&file).unwrap();
            for (i, p) in img.rgba.chunks_exact(4).enumerate() { assert_eq!(p[3], if i % 3 == 0 { 0 } else { 255 }, "{ct:?} pixel {i} alpha"); }
        }
        // 16-bit and interlaced inputs must be refused (the png crate handles them)
        let mut file = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut file, 4, 4);
            enc.set_color(png::ColorType::Rgb); enc.set_depth(png::BitDepth::Sixteen);
            enc.write_header().unwrap().write_image_data(&[0u8; 4 * 4 * 6]).unwrap();
        }
        assert!(load_png_fast(&file).is_none());
        assert!(load_png(&file).unwrap().depth16, "16-bit input must be flagged as reduced");
    }

    /// Chunks of a PNG file as (type, body); `build` writes them back with fresh CRCs.
    fn chunks(file: &[u8]) -> Vec<([u8; 4], Vec<u8>)> {
        let (mut pos, mut out) = (8usize, Vec::new());
        while pos + 8 <= file.len() {
            let n = u32::from_be_bytes(file[pos..pos + 4].try_into().unwrap()) as usize;
            out.push((file[pos + 4..pos + 8].try_into().unwrap(), file[pos + 8..pos + 8 + n].to_vec()));
            pos += 12 + n;
        }
        out
    }
    fn build(chunks: &[([u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        for (ty, body) in chunks { chunk(&mut out, ty, body); }
        out
    }

    /// A file the png crate rejects must not be accepted by the own reader (with one thread the crate reads every
    /// file, with more the own reader does: the answer must not depend on that). Ancillary chunks it does not know
    /// must still pass (macOS screenshots carry iCCP, pHYs, eXIf). APNG is refused by both readers.
    #[test]
    fn doubtful_png_files_are_refused_by_both_readers() {
        let mut good = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut good, 8, 4);
            enc.set_color(png::ColorType::Rgb); enc.set_depth(png::BitDepth::Eight);
            enc.write_header().unwrap().write_image_data(&(0..8 * 4 * 3).map(|i| i as u8).collect::<Vec<_>>()).unwrap();
        }
        let ch = chunks(&good);
        assert_eq!(ch.iter().map(|(t, _)| *t).collect::<Vec<_>>(), [*b"IHDR", *b"IDAT", *b"IEND"]);
        let reference = load_png_fast(&good).expect("the valid file must take the fast path");
        let with = |extra: ([u8; 4], Vec<u8>)| { let mut c = ch.clone(); c.insert(1, extra); build(&c) };
        let ihdr = |f: &dyn Fn(&mut Vec<u8>)| { let mut c = ch.clone(); f(&mut c[0].1); build(&c) };
        let mut bad_ihdr_crc = good.clone(); bad_ihdr_crc[29] ^= 0xFF; // the CRC of IHDR starts at 8 + 8 + 13
        let mut bad_idat_crc = good.clone(); let n = bad_idat_crc.len(); bad_idat_crc[n - 16] ^= 0xFF; // the 4 bytes before IEND
        let no_iend = good[..good.len() - 12].to_vec();
        let doubtful: Vec<(&str, Vec<u8>)> = vec![
            ("wrong IHDR CRC", bad_ihdr_crc),
            ("wrong IDAT CRC", bad_idat_crc),
            ("missing IEND", no_iend),
            ("unknown critical chunk", with((*b"ABCD", b"x".to_vec()))),
            ("APNG acTL", with((*b"acTL", vec![0, 0, 0, 2, 0, 0, 0, 0]))),
            ("compression method 1", ihdr(&|b| b[10] = 1)),
            ("filter method 1", ihdr(&|b| b[11] = 1)),
            ("65535 x 65535 header", ihdr(&|b| { b[0..4].copy_from_slice(&65535u32.to_be_bytes()); b[4..8].copy_from_slice(&65535u32.to_be_bytes()); })),
            ("4000 x 4000 header on 8 x 4 of data", ihdr(&|b| { b[0..4].copy_from_slice(&4000u32.to_be_bytes()); b[4..8].copy_from_slice(&4000u32.to_be_bytes()); })),
        ];
        for (what, file) in &doubtful {
            assert!(load_png_fast(file).is_none(), "{what}: the fast reader accepted it");
            assert!(load_png(file).is_err(), "{what}: the png crate accepted it");
        }
        assert!(load_png(&doubtful[4].1).err().unwrap().contains("APNG"));
        // unknown ancillary chunks: still the fast path, same pixels
        let ancillary = with((*b"tEXt", b"Comment\0hello".to_vec()));
        let img = load_png_fast(&ancillary).expect("an ancillary chunk must not push the file off the fast path");
        assert!(img.rgba == reference.rgba);
    }

    /// Chunk order and shape (P37): whatever the fast reader accepts, the png crate must accept too, with the same
    /// pixels; otherwise a file would be read with 2+ threads and refused with 1. Mutants: IDAT before IHDR, PLTE
    /// twice, a PLTE of 4 bytes, PLTE after IDAT, PLTE on a greyscale image, tRNS twice or before PLTE, a tEXt chunk
    /// between two IDAT chunks. The invariant is one-directional: the crate may accept what the fast reader defers.
    #[test]
    fn chunk_structure_is_judged_alike_by_both_readers() {
        let mut seed = 5u32;
        let mut lcg = move || { seed = seed.wrapping_mul(1664525).wrapping_add(1013904223); (seed >> 24) as u8 };
        let mut encode = |ct: png::ColorType, palette: bool| {
            let mut file = Vec::new();
            let mut enc = png::Encoder::new(&mut file, 8, 4);
            enc.set_color(ct); enc.set_depth(png::BitDepth::Eight);
            if palette { enc.set_palette((0..256 * 3).map(|_| lcg()).collect::<Vec<u8>>()); enc.set_trns((0..100).map(|_| lcg()).collect::<Vec<u8>>()); }
            let bpp = ct.samples();
            enc.write_header().unwrap().write_image_data(&(0..8 * 4 * bpp).map(|i| (i % 7) as u8).collect::<Vec<_>>()).unwrap();
            file
        };
        let indexed = chunks(&encode(png::ColorType::Indexed, true));
        let grey = chunks(&encode(png::ColorType::Grayscale, false));
        let rgb = chunks(&encode(png::ColorType::Rgb, false));
        assert_eq!(indexed.iter().map(|(t, _)| *t).collect::<Vec<_>>(), [*b"IHDR", *b"PLTE", *b"tRNS", *b"IDAT", *b"IEND"]);
        let at = |c: &[([u8; 4], Vec<u8>)], ty: &[u8; 4]| c.iter().position(|(t, _)| t == ty).unwrap();
        let edit = |c: &[([u8; 4], Vec<u8>)], f: &dyn Fn(&mut Vec<([u8; 4], Vec<u8>)>)| { let mut c = c.to_vec(); f(&mut c); build(&c) };
        let split_idat = |c: &[([u8; 4], Vec<u8>)], between: ([u8; 4], Vec<u8>)| edit(c, &|c| {
            let i = at(c, b"IDAT"); let body = c[i].1.clone(); let (a, b) = body.split_at(body.len() / 2);
            c[i].1 = a.to_vec(); c.insert(i + 1, between.clone()); c.insert(i + 2, (*b"IDAT", b.to_vec()));
        });
        let mutants: Vec<(&str, Vec<u8>)> = vec![
            ("IDAT before IHDR", edit(&rgb, &|c| c.swap(0, 1))),
            ("PLTE twice", edit(&indexed, &|c| { let i = at(c, b"PLTE"); let p = c[i].clone(); c.insert(i, p); })),
            ("PLTE of 4 bytes", edit(&indexed, &|c| { let i = at(c, b"PLTE"); c[i].1 = vec![1, 2, 3, 4]; })),
            ("PLTE after IDAT", edit(&indexed, &|c| { let i = at(c, b"PLTE"); let p = c.remove(i); let j = at(c, b"IDAT"); c.insert(j + 1, p); })),
            ("PLTE on a greyscale image", edit(&grey, &|c| c.insert(1, (*b"PLTE", vec![0, 0, 0, 255, 255, 255])))),
            ("tRNS twice", edit(&indexed, &|c| { let i = at(c, b"tRNS"); let t = c[i].clone(); c.insert(i, t); })),
            ("tRNS before PLTE", edit(&indexed, &|c| c.swap(1, 2))),
            ("tEXt between two IDAT chunks", split_idat(&rgb, (*b"tEXt", b"Comment\0x".to_vec()))),
            ("two IDAT chunks", split_idat(&indexed, (*b"tEXt", b"Comment\0x".to_vec()))),
        ];
        // the last mutant is actually valid if the tEXt is removed: keep one plain two-IDAT file as the control
        let control = edit(&indexed, &|c| { let i = at(c, b"IDAT"); let body = c[i].1.clone(); let (a, b) = body.split_at(body.len() / 2); c[i].1 = a.to_vec(); c.insert(i + 1, (*b"IDAT", b.to_vec())); });
        let img = load_png_fast(&control).expect("consecutive IDAT chunks must stay on the fast path");
        assert!(img.rgba == load_png(&control).unwrap().rgba);
        // the png crate (0.18.1) panics instead of erroring on a PLTE of 4 bytes; `load_png` refuses that before
        // decoding, and a panic would count as a refusal here anyway (the fast reader must have deferred the file)
        let quiet = std::panic::take_hook(); std::panic::set_hook(Box::new(|_| {}));
        let outcome: Vec<(&str, bool, Option<bool>)> = mutants.iter().map(|(what, file)| {
            let fast = load_png_fast(file);
            let slow = std::panic::catch_unwind(|| load_png(file));
            let slow_ok = match &slow { Ok(Ok(img)) => { if let Some(f) = &fast { assert!(f.rgba == img.rgba, "{what}: both readers accepted it with different pixels"); } Some(true) } Ok(Err(_)) => Some(false), Err(_) => None };
            (*what, fast.is_some(), slow_ok)
        }).collect();
        std::panic::set_hook(quiet);
        for (what, fast, slow) in &outcome {
            eprintln!("  {what}: fast {} / png crate {}", if *fast { "accepts" } else { "defers" }, match slow { Some(true) => "accepts", Some(false) => "refuses", None => "panics" });
            assert!(!*fast || *slow == Some(true), "{what}: the fast reader accepted a file the png crate does not decode");
        }
    }

    /// A bottom-up 32-bit BMP with the given info header size, compression and r, g, b, a bitfield masks (the alpha
    /// mask is written only for headers of 56 bytes or more); `px(x, y)` gives the stored bytes of a pixel.
    fn bmp32(w: usize, h: usize, hdr: u32, comp: u32, masks: [u32; 4], px: impl Fn(usize, usize) -> [u8; 4]) -> Vec<u8> {
        let mut pixels = Vec::new();
        for y in (0..h).rev() { for x in 0..w { pixels.extend_from_slice(&px(x, y)); } }
        let off = 14 + hdr as usize + if comp == 3 && hdr == 40 { 12 } else { 0 };
        let mut f = b"BM".to_vec();
        f.extend_from_slice(&((off + pixels.len()) as u32).to_le_bytes()); f.extend_from_slice(&[0; 4]); f.extend_from_slice(&(off as u32).to_le_bytes());
        f.extend_from_slice(&hdr.to_le_bytes()); f.extend_from_slice(&(w as i32).to_le_bytes()); f.extend_from_slice(&(h as i32).to_le_bytes());
        f.extend_from_slice(&1u16.to_le_bytes()); f.extend_from_slice(&32u16.to_le_bytes()); f.extend_from_slice(&comp.to_le_bytes());
        f.extend_from_slice(&(pixels.len() as u32).to_le_bytes()); f.extend_from_slice(&[0; 16]);
        if comp == 3 { for m in &masks[..if hdr >= 56 { 4 } else { 3 }] { f.extend_from_slice(&m.to_le_bytes()); } }
        f.resize(off, 0); // colour space and gamma fields of a V4 header
        f.extend_from_slice(&pixels);
        f
    }

    /// Alpha of a 32-bit BMP comes from the header: BI_RGB and three-mask BITFIELDS files are opaque whatever their
    /// fourth byte holds, and a file with an alpha mask keeps its alpha even when it is 0 everywhere.
    #[test]
    fn bmp_alpha_follows_the_header_not_the_bytes() {
        let bgr = |x: usize, y: usize| [50u8, 100, (y * 10) as u8 + if x % 2 == 0 { 0 } else { 100 }]; // stored b, g, r
        let rgb = [0xFF_0000u32, 0xFF00, 0xFF];
        let cases: Vec<(&str, Vec<u8>, Box<dyn Fn(usize, usize) -> u8>)> = vec![
            ("BI_RGB, fourth byte 7", bmp32(5, 3, 40, 0, [0; 4], |x, y| { let [b, g, r] = bgr(x, y); [b, g, r, 7] }), Box::new(|_, _| 255)),
            ("BI_RGB, fourth byte 0", bmp32(5, 3, 40, 0, [0; 4], |x, y| { let [b, g, r] = bgr(x, y); [b, g, r, 0] }), Box::new(|_, _| 255)),
            ("BITFIELDS, three masks, fourth byte 7", bmp32(5, 3, 40, 3, [rgb[0], rgb[1], rgb[2], 0], |x, y| { let [b, g, r] = bgr(x, y); [b, g, r, 7] }), Box::new(|_, _| 255)),
            ("V4, alpha mask, alpha 0 everywhere", bmp32(5, 3, 108, 3, [rgb[0], rgb[1], rgb[2], 0xFF00_0000], |x, y| { let [b, g, r] = bgr(x, y); [b, g, r, 0] }), Box::new(|_, _| 0)),
            ("V4, alpha mask, real alpha", bmp32(5, 3, 108, 3, [rgb[0], rgb[1], rgb[2], 0xFF00_0000], |x, y| { let [b, g, r] = bgr(x, y); [b, g, r, if x < 2 { 128 } else { 255 }] }), Box::new(|x, _| if x < 2 { 128 } else { 255 })),
            ("V4, alpha mask first (ARGB order)", bmp32(5, 3, 108, 3, [0xFF00, 0xFF_0000, 0xFF00_0000, 0xFF], |x, y| { let [b, g, r] = bgr(x, y); [200, r, g, b] }), Box::new(|_, _| 200)),
        ];
        for (what, file, want_a) in &cases {
            let img = load_bmp(file).unwrap_or_else(|e| panic!("{what}: {e}"));
            assert_eq!((img.w, img.h), (5, 3), "{what}");
            for y in 0..3 { for x in 0..5 {
                let p = &img.rgba[(y * 5 + x) * 4..][..4];
                let [b, g, r] = bgr(x, y);
                assert_eq!(p, &[r, g, b, want_a(x, y)], "{what}: pixel ({x}, {y})");
            } }
        }
    }

    /// A matrix/TRC ICC profile (v2, display class, RGB, PCS XYZ) with the sRGB colorants adapted to D50 and one
    /// tone curve for the three channels: `curve` is a complete 'curv' or 'para' tag.
    fn icc_profile(curve: &[u8]) -> Vec<u8> {
        let xyz = |x: f64, y: f64, z: f64| { let mut t = b"XYZ \0\0\0\0".to_vec(); for v in [x, y, z] { t.extend_from_slice(&((v * 65536.0).round() as i32).to_be_bytes()); } t };
        let tags: Vec<([u8; 4], Vec<u8>)> = vec![
            (*b"wtpt", xyz(0.9642, 1.0, 0.8249)),
            (*b"rXYZ", xyz(0.4361, 0.2225, 0.0139)), (*b"gXYZ", xyz(0.3851, 0.7169, 0.0971)), (*b"bXYZ", xyz(0.1431, 0.0606, 0.7141)),
            (*b"rTRC", curve.to_vec()), (*b"gTRC", curve.to_vec()), (*b"bTRC", curve.to_vec()),
        ];
        let mut p = vec![0u8; 128 + 4 + 12 * tags.len()];
        p[8] = 2; p[12..16].copy_from_slice(b"mntr"); p[16..20].copy_from_slice(b"RGB "); p[20..24].copy_from_slice(b"XYZ "); p[36..40].copy_from_slice(b"acsp");
        p[68..80].copy_from_slice(&xyz(0.9642, 1.0, 0.8249)[8..]);
        p[128..132].copy_from_slice(&(tags.len() as u32).to_be_bytes());
        for (i, (sig, body)) in tags.iter().enumerate() {
            while p.len() % 4 != 0 { p.push(0); }
            let at = 132 + 12 * i;
            let here = p.len() as u32;
            p[at..at + 4].copy_from_slice(sig); p[at + 4..at + 8].copy_from_slice(&here.to_be_bytes()); p[at + 8..at + 12].copy_from_slice(&(body.len() as u32).to_be_bytes());
            p.extend_from_slice(body);
        }
        let n = p.len() as u32; p[0..4].copy_from_slice(&n.to_be_bytes());
        p
    }
    /// A GRAY ICC profile (v2, display class, PCS XYZ) with one tone curve (`kTRC`).
    fn icc_gray_profile(curve: &[u8]) -> Vec<u8> {
        let mut p = icc_profile(curve);
        // rebuild: header as the RGB one but colour space GRAY, tags wtpt + kTRC
        let xyz = |x: f64, y: f64, z: f64| { let mut t = b"XYZ \0\0\0\0".to_vec(); for v in [x, y, z] { t.extend_from_slice(&((v * 65536.0).round() as i32).to_be_bytes()); } t };
        p.truncate(128); p[16..20].copy_from_slice(b"GRAY");
        let tags: Vec<([u8; 4], Vec<u8>)> = vec![(*b"wtpt", xyz(0.9642, 1.0, 0.8249)), (*b"kTRC", curve.to_vec())];
        p.extend_from_slice(&(tags.len() as u32).to_be_bytes()); p.resize(132 + 12 * tags.len(), 0);
        for (i, (sig, body)) in tags.iter().enumerate() {
            while p.len() % 4 != 0 { p.push(0); }
            let (at, here) = (132 + 12 * i, p.len() as u32);
            p[at..at + 4].copy_from_slice(sig); p[at + 4..at + 8].copy_from_slice(&here.to_be_bytes()); p[at + 8..at + 12].copy_from_slice(&(body.len() as u32).to_be_bytes());
            p.extend_from_slice(body);
        }
        let n = p.len() as u32; p[0..4].copy_from_slice(&n.to_be_bytes());
        p
    }
    fn curv_gamma(g: f32) -> Vec<u8> { let mut t = b"curv\0\0\0\0\0\0\0\x01".to_vec(); t.extend_from_slice(&((g * 256.0) as u16).to_be_bytes()); t }
    fn para_srgb() -> Vec<u8> { let mut t = b"para\0\0\0\0\0\x03\0\0".to_vec(); for v in [2.4f64, 1.0 / 1.055, 0.055 / 1.055, 1.0 / 12.92, 0.04045] { t.extend_from_slice(&((v * 65536.0).round() as i32).to_be_bytes()); } t }
    fn short(c: &cm::Colour) -> String { match c { cm::Colour::Profile(p) => format!("Profile({} bytes)", p.len()), c => format!("{c:?}") } }

    /// Both readers must find the same colour tag (iCCP over sRGB over gAMA/cHRM; an iCCP that does not inflate
    /// counts as absent, as in the png crate; duplicates and bad values are refused by both). The palette is
    /// converted to sRGB for a profile or gamma that is not sRGB, left alone for one that is (an embedded sRGB
    /// profile) and an unreadable profile is written back as iCCP. An untagged input gets no colour chunk at all.
    #[test]
    fn colour_tags_are_read_alike_and_written_as_srgb() {
        let mut good = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut good, 8, 4);
            enc.set_color(png::ColorType::Rgb); enc.set_depth(png::BitDepth::Eight);
            enc.write_header().unwrap().write_image_data(&(0..8 * 4 * 3).map(|i| (i * 5) as u8).collect::<Vec<_>>()).unwrap();
        }
        let ch = chunks(&good);
        let with = |extra: &[([u8; 4], Vec<u8>)]| { let mut c = ch.clone(); for (i, e) in extra.iter().enumerate() { c.insert(1 + i, e.clone()); } build(&c) };
        let iccp = |profile: &[u8]| { let mut b = b"ICC profile\0\0".to_vec(); b.extend_from_slice(&zlib_parallel(profile, 6)); (*b"iCCP", b) };
        let gama = |v: u32| (*b"gAMA", v.to_be_bytes().to_vec());
        let chrm_srgb = (*b"cHRM", [31270u32, 32900, 64000, 33000, 30000, 60000, 15000, 6000].iter().flat_map(|v| v.to_be_bytes()).collect::<Vec<_>>());
        let g18 = icc_profile(&curv_gamma(1.8));
        let gray18 = icc_gray_profile(&curv_gamma(1.8));
        let mut grey_png = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut grey_png, 8, 4);
            enc.set_color(png::ColorType::Grayscale); enc.set_depth(png::BitDepth::Eight);
            enc.write_header().unwrap().write_image_data(&(0..8 * 4).map(|i| (i * 8) as u8).collect::<Vec<_>>()).unwrap();
        }
        let gch = chunks(&grey_png);
        let grey_with = |extra: ([u8; 4], Vec<u8>)| { let mut c = gch.clone(); c.insert(1, extra); build(&c) };
        let cases: Vec<(&str, Vec<u8>, cm::Colour)> = vec![
            ("greyscale + GRAY profile", grey_with(iccp(&gray18)), cm::Colour::GrayProfile(gray18.clone())),
            ("RGB + GRAY profile (invalid, ignored) + gAMA", with(&[iccp(&gray18), gama(55556)]), cm::Colour::Gamma { gamma: 0.55556, chrm: None }),
            ("untagged", good.clone(), cm::Colour::None),
            ("sRGB chunk", with(&[(*b"sRGB", vec![0])]), cm::Colour::Srgb),
            ("gAMA 1/2.2 + sRGB cHRM", with(&[gama(45455), chrm_srgb.clone()]), cm::Colour::Srgb),
            ("gAMA 1/1.8", with(&[gama(55556)]), cm::Colour::Gamma { gamma: 0.55556, chrm: None }),
            ("gAMA 1/2.2 + P3 cHRM", with(&[gama(45455), (*b"cHRM", [31270u32, 32900, 68000, 32000, 26500, 69000, 15000, 6000].iter().flat_map(|v| v.to_be_bytes()).collect())]),
                cm::Colour::Gamma { gamma: 0.45455, chrm: Some([0.3127, 0.329, 0.68, 0.32, 0.265, 0.69, 0.15, 0.06]) }),
            ("iCCP gamma 1.8", with(&[iccp(&g18)]), cm::Colour::Profile(g18.clone())),
            ("iCCP over sRGB", with(&[(*b"sRGB", vec![0]), iccp(&g18)]), cm::Colour::Profile(g18.clone())),
            ("iCCP that does not inflate, then gAMA", with(&[(*b"iCCP", b"ICC profile\0\0garbage".to_vec()), gama(55556)]), cm::Colour::Gamma { gamma: 0.55556, chrm: None }),
        ];
        for (what, file, want) in &cases {
            let fast = load_png_fast(file).unwrap_or_else(|| panic!("{what}: the fast reader refused it"));
            let slow = load_png(file).unwrap_or_else(|e| panic!("{what}: the png crate refused it: {e}"));
            assert!(fast.colour == *want && slow.colour == *want, "{what}: fast {} / crate {} / want {}", short(&fast.colour), short(&slow.colour), short(want));
        }
        // doubtful colour chunks: the png crate drops the offending chunk and keeps what it had (a benign error in
        // an ancillary chunk); the fast reader does not mirror that, it defers to the crate
        let after_idat = { let mut c = ch.clone(); c.insert(2, gama(55556)); build(&c) };
        for (what, file, crate_colour) in [
            ("duplicate gAMA", with(&[gama(45455), gama(45455)]), cm::Colour::Srgb),
            ("gAMA 0", with(&[gama(0)]), cm::Colour::None),
            ("sRGB intent 9", with(&[(*b"sRGB", vec![9])]), cm::Colour::None),
            ("cHRM of 31 bytes", with(&[gama(45455), (*b"cHRM", vec![0; 31])]), cm::Colour::Srgb),
            ("gAMA after IDAT", after_idat, cm::Colour::None),
        ] {
            assert!(load_png_fast(&file).is_none(), "{what}: the fast reader accepted it");
            assert_eq!(load_png(&file).unwrap_or_else(|e| panic!("{what}: the png crate refused it: {e}")).colour, crate_colour, "{what}");
        }
        // the palette: a gamma 1.8 curve brightens mid grey (128 -> 147), keeps black and white and the alpha
        let pal: Vec<Rgba> = [0u8, 64, 128, 192, 255].iter().map(|&v| Rgba { r: v, g: v, b: v, a: 255 }).chain([Rgba { r: 255, g: 0, b: 0, a: 128 }]).collect();
        let t = cm::to_srgb(&cm::Colour::Profile(g18.clone()), &pal);
        assert_eq!(t.note, "ICC profile converted to sRGB");
        let g: Vec<u8> = t.pal.iter().map(|c| c.g).collect();
        assert!(g[0] == 0 && g[4] == 255 && (145..=149).contains(&g[2]) && g[1] > 64 && g[3] > 192, "gamma 1.8 palette: {g:?}");
        assert!(t.pal[5].a == 128 && t.pal[5].r == 255, "alpha and pure red must pass through: {:?}", t.pal[5]);
        let t = cm::to_srgb(&cm::Colour::Gamma { gamma: 0.55556, chrm: None }, &pal);
        assert!(t.note == "gAMA/cHRM converted to sRGB" && (145..=149).contains(&t.pal[2].g), "gAMA 1/1.8 palette: {:?}", t.pal[2]);
        let t = cm::to_srgb(&cm::Colour::Profile(icc_profile(&para_srgb())), &pal);
        assert!(t.note == "sRGB (ICC profile)" && t.pal == pal, "an sRGB profile must leave the palette alone: {}", t.note);
        // a GRAY gamma 1.8 profile on a greyscale image: the same 128 -> 147 through the Gray8 path, greys stay grey
        let t = cm::to_srgb(&cm::Colour::GrayProfile(gray18.clone()), &pal);
        assert!(t.note == "grey ICC profile converted to sRGB" && (145..=149).contains(&t.pal[2].g) && t.pal[2].r == t.pal[2].g && t.pal[2].g == t.pal[2].b && t.pal[0].g == 0 && t.pal[4].g == 255, "gray profile palette: {:?}", t.pal);
        let t = cm::to_srgb(&cm::Colour::GrayProfile(icc_gray_profile(&para_srgb())), &pal);
        assert!(t.note == "sRGB (grey ICC profile)" && t.pal == pal, "an sRGB grey profile must leave the palette alone: {}", t.note);
        let t = cm::to_srgb(&cm::Colour::GrayProfile(b"not a profile at all".to_vec()), &pal);
        assert!(t.note == "grey ICC profile not readable, dropped" && t.chunks.is_empty(), "{}", t.note);
        let kept = cm::to_srgb(&cm::Colour::Profile(b"not a profile at all".to_vec()), &pal);
        assert!(kept.note == "ICC profile kept, not converted" && kept.pal == pal, "{}", kept.note);
        // the output: colour chunks between IHDR and PLTE; an unreadable profile comes back as iCCP; no tag, no chunk
        let types = |out: &[u8]| chunks(out).iter().map(|(t, _)| *t).collect::<Vec<_>>();
        let out = encode_indexed(2, 1, &pal, vec![0, 0, 1], None, &cm::to_srgb(&cm::Colour::Srgb, &pal).chunks);
        assert_eq!(types(&out), [*b"IHDR", *b"sRGB", *b"gAMA", *b"PLTE", *b"tRNS", *b"IDAT", *b"IEND"]);
        assert_eq!(load_png(&out).unwrap().colour, cm::Colour::Srgb);
        let out = encode_indexed(2, 1, &pal, vec![0, 0, 1], None, &kept.chunks);
        assert_eq!(types(&out)[..2], [*b"IHDR", *b"iCCP"]);
        assert_eq!(load_png(&out).unwrap().colour, cm::Colour::Profile(b"not a profile at all".to_vec()));
        let out = encode_indexed(2, 1, &pal, vec![0, 0, 1], None, &cm::to_srgb(&cm::Colour::None, &pal).chunks);
        assert_eq!(types(&out), [*b"IHDR", *b"PLTE", *b"tRNS", *b"IDAT", *b"IEND"]);
    }

    /// A V5 BMP names its colour space: LCS_sRGB and LCS_WINDOWS_COLOR_SPACE are sRGB (what macOS ImageIO writes
    /// after converting the pixels), PROFILE_EMBEDDED carries a profile, anything else is untagged. The truecolor
    /// output of an sRGB BMP restates the tag.
    #[test]
    fn bmp_v5_colour_space_is_read() {
        let px = |x: usize, y: usize| [x as u8 * 40, y as u8 * 90, 7, 255];
        let masks = [0xFF_0000, 0xFF00, 0xFF, 0xFF00_0000];
        let mut f = bmp32(3, 2, 124, 3, masks, px);
        assert_eq!(load_bmp(&f).unwrap().colour, cm::Colour::None, "LCS_CALIBRATED_RGB (0) is untagged");
        f[70..74].copy_from_slice(b"BGRs"); // LCS_sRGB
        assert_eq!(load_bmp(&f).unwrap().colour, cm::Colour::Srgb);
        let out = encode_truecolor(&load_bmp(&f).unwrap()).unwrap();
        assert_eq!(chunks(&out).iter().map(|(t, _)| *t).collect::<Vec<_>>()[..3], [*b"IHDR", *b"sRGB", *b"gAMA"]);
        assert_eq!(load_png(&out).unwrap().colour, cm::Colour::Srgb);
        f[70..74].copy_from_slice(b" niW"); // LCS_WINDOWS_COLOR_SPACE
        assert_eq!(load_bmp(&f).unwrap().colour, cm::Colour::Srgb);
        let profile = icc_profile(&curv_gamma(1.8));
        let at = f.len(); f.extend_from_slice(&profile);
        f[70..74].copy_from_slice(b"DEBM"); // PROFILE_EMBEDDED, offset from the info header
        f[126..130].copy_from_slice(&((at - 14) as u32).to_le_bytes()); f[130..134].copy_from_slice(&(profile.len() as u32).to_le_bytes());
        assert_eq!(load_bmp(&f).unwrap().colour, cm::Colour::Profile(profile));
        f[130..134].copy_from_slice(&u32::MAX.to_le_bytes()); // a size beyond the file: untagged, not a panic
        assert_eq!(load_bmp(&f).unwrap().colour, cm::Colour::None);
    }

    /// The packer for 1, 2 and 4 bits per pixel (P45, no division per pixel) gives what the plain formula gives
    /// (`o[1 + i / per] |= v << (8 - bits - (i % per) * bits)`, the 0.23.1 code), on widths that are and are not
    /// multiples of the pixels per byte, and the PNG built from it reads back through the png crate.
    #[test]
    fn packed_bit_depths_match_the_plain_formula_and_read_back() {
        let mut s = 5u32;
        let mut lcg = move || { s = s.wrapping_mul(1664525).wrapping_add(1013904223); s >> 8 };
        for (bits, colours) in [(1usize, 2usize), (2, 3), (4, 12)] {
            for w in [1usize, 7, 8, 9, 64, 301] {
                let h = 5;
                let mut raw = Vec::with_capacity((w + 1) * h);
                for _ in 0..h { raw.push(0u8); for _ in 0..w { raw.push((lcg() as usize % colours) as u8); } }
                let per = 8 / bits;
                let bw = w.div_ceil(per) + 1;
                let mut want = vec![0u8; bw * h];
                for y in 0..h { for i in 0..w { want[y * bw + 1 + i / per] |= raw[y * (w + 1) + 1 + i] << (8 - bits - (i % per) * bits); } }
                assert_eq!(pack_bits(&raw, w, bits), want, "{bits} bits, width {w}");
                let pal: Vec<Rgba> = (0..colours).map(|i| Rgba { r: (i * 20) as u8, g: (i * 7) as u8, b: 255 - (i * 13) as u8, a: 255 }).collect();
                let png = encode_indexed(w, h, &pal, raw.clone(), None, &cm::to_srgb(&cm::Colour::None, &pal).chunks);
                let img = load_png(&png).expect("readable");
                for y in 0..h { for i in 0..w {
                    let c = pal[raw[y * (w + 1) + 1 + i] as usize];
                    assert_eq!(&img.rgba[(y * w + i) * 4..(y * w + i) * 4 + 4], &[c.r, c.g, c.b, 255], "{bits} bits, width {w}, pixel ({i},{y})");
                } }
            }
        }
    }

    /// `--level` reaches every chunk of the parallel deflate (0.23.0 compressed at 9 whatever was asked): the
    /// stream of each level inflates back to the input, a low level is larger than a high one, and the rule that
    /// picks 8 per chunk only applies to level 9.
    #[test]
    fn deflate_level_is_honoured_per_chunk() {
        use std::io::Read;
        let mut s = 12345u32;
        let mut lcg = || { s = s.wrapping_mul(1_103_515_245).wrapping_add(12345); s >> 8 };
        // ~300 KB of screen-like rows (runs of one index, glyph-like bursts): four 64 KB chunks
        let mut raw = Vec::with_capacity(300_000);
        while raw.len() < 300_000 {
            let n = (4 + lcg() % 120) as usize;
            let c = (lcg() % 12) as u8;
            if lcg() % 5 == 0 { for _ in 0..n { raw.push((lcg() % 40) as u8); } } else { for _ in 0..n { raw.push(c); } }
        }
        let inflate = |z: &[u8]| { let mut a = Vec::new(); flate2::read::ZlibDecoder::new(z).read_to_end(&mut a).expect("inflate"); a };
        let sizes: Vec<usize> = [1, 3, 6, 9].iter().map(|&l| { let z = zlib_parallel(&raw, l); assert_eq!(inflate(&z), raw, "level {l}"); z.len() }).collect();
        // 1 and 3 against 6: none of them is touched by the per-chunk rule (it only applies at 9), so with the
        // 0.23.0 bug all three streams were the same level-9 bytes
        assert!(sizes[0] > sizes[2] && sizes[1] > sizes[2], "level 1 / 3 should be larger than 6: {sizes:?}");
    }
}
