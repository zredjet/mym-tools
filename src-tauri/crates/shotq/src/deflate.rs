//! Parallel deflate with libdeflate (docs/size-plan.md phase 1; experiment behind `SHOTQ_DEFLATE=libdeflate`).
//!
//! libdeflate compresses whole buffers only: no dictionary, no flush, and every call returns a complete raw deflate
//! stream whose last block carries BFINAL = 1. To make one zlib stream out of independently compressed chunks (what
//! `zlib_parallel` gets from zlib-rs with a sync flush), every fragment but the last is walked block by block
//! (RFC 1951) to find the header bit of its final block and the bit where its data ends; BFINAL is cleared, the
//! padding bits after the end are zeroed, and an empty stored block (BFINAL 0, BTYPE 00, byte aligned, LEN 0,
//! NLEN 0xFFFF) is appended so that the fragment ends on a byte boundary and the next fragment's first block header
//! follows it directly (size-plan.md 8.2, method B: nothing vendored, libdeflate untouched). The 4-6 bytes per
//! fragment cost about 0.02%. Chunk boundaries fall on row starts. Adler-32 is combined from the chunks. The output
//! depends only on the data, the level and the row length, never on the thread count or on which compressor
//! instance handled a chunk (`compressor_reuse_is_deterministic`).
//!
//! Measured before this existed (dfbench, same chunks, no dictionary, M4 Max 16 threads): libdeflate level 9 is
//! -2.5% against zlib-rs level 6 on the owner's screenshots for +4 ms, level 10 -4..-5% for +20 ms (HANDOFF P32).

use rayon::prelude::*;

/// Which deflate implementation `encode_indexed` uses: `SHOTQ_DEFLATE=libdeflate` selects this module, with the
/// level from `SHOTQ_DEFLATE_LEVEL` (1-12, default 9); anything else keeps zlib-rs (the shipped behaviour).
pub enum Backend { ZlibRs, Libdeflate(i32) }
pub fn backend() -> Backend {
    match std::env::var("SHOTQ_DEFLATE").as_deref() {
        Ok("libdeflate") => Backend::Libdeflate(std::env::var("SHOTQ_DEFLATE_LEVEL").ok().and_then(|s| s.parse().ok()).unwrap_or(9).clamp(1, 12)),
        _ => Backend::ZlibRs,
    }
}

/// Chunk length in bytes: the 1/32 rule of `zlib_parallel` (64-256 KB) rounded down to whole rows, at least one row.
pub fn chunk_rows(len: usize, row: usize) -> usize {
    let target = crate::deflate_chunk(len);
    (target / row.max(1)).max(1) * row.max(1)
}

/// One zlib stream of `raw` (rows of `row` bytes) compressed by libdeflate in parallel, row-aligned chunks.
pub fn libdeflate_parallel(raw: &[u8], level: i32, row: usize) -> Vec<u8> {
    let chunk = chunk_rows(raw.len(), row);
    let n = raw.len().div_ceil(chunk).max(1);
    let lvl = libdeflater::CompressionLvl::new(level).expect("libdeflate level 1-12");
    let parts: Vec<(Vec<u8>, u32)> = (0..n).into_par_iter().map_init(|| libdeflater::Compressor::new(lvl), |c, i| {
        let (start, end) = (i * chunk, ((i + 1) * chunk).min(raw.len()));
        let input = &raw[start..end];
        let mut out = vec![0u8; c.deflate_compress_bound(input.len()) + 8];
        let sz = c.deflate_compress(input, &mut out).expect("libdeflate compress");
        out.truncate(sz);
        if end < raw.len() { make_nonfinal(&mut out, input.len()).expect("libdeflate fragment"); }
        (out, simd_adler32::adler32(&input))
    }).collect();
    let mut z = Vec::with_capacity(parts.iter().map(|p| p.0.len()).sum::<usize>() + 6);
    z.extend_from_slice(&[0x78, 0xDA]);
    let mut adler = 1u32;
    for (i, (part, a)) in parts.iter().enumerate() {
        z.extend_from_slice(part);
        let len = (((i + 1) * chunk).min(raw.len()) - i * chunk) as u32;
        adler = if i == 0 { *a } else { crate::adler32_combine(adler, *a, len) };
    }
    z.extend_from_slice(&adler.to_be_bytes());
    z
}

/// Turns a complete raw deflate stream of `raw_len` bytes into a non-final fragment: BFINAL of its last block
/// cleared, padding zeroed, an empty stored block appended. Returns the bit phase `p` of the data end (0..8), which
/// decides whether the stored block's 3 header bits fit in the last byte (1..=5) or need a byte of their own.
pub fn make_nonfinal(frag: &mut Vec<u8>, raw_len: usize) -> Result<usize, &'static str> {
    let (hdr, end, n) = walk(frag)?;
    if n != raw_len { return Err("fragment decodes to the wrong length"); }
    frag[hdr >> 3] &= !(1u8 << (hdr & 7));
    let p = end & 7;
    let nbytes = (end + 7) >> 3;
    frag.truncate(nbytes);
    if p != 0 { frag[nbytes - 1] &= (1u8 << p) - 1; }
    if p == 0 || p > 5 { frag.push(0); }
    frag.extend_from_slice(&[0x00, 0x00, 0xFF, 0xFF]);
    Ok(p)
}

// ---------------------------------------------------------------- a minimal RFC 1951 walker (no output, only positions)

const LEN_BASE: [u16; 29] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA: [u8; 29] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_EXTRA: [u8; 30] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

struct Bits<'a> { d: &'a [u8], pos: usize }
impl Bits<'_> {
    fn bit(&mut self) -> Result<u32, &'static str> {
        let i = self.pos >> 3;
        if i >= self.d.len() { return Err("truncated deflate stream"); }
        let v = (self.d[i] >> (self.pos & 7)) & 1;
        self.pos += 1;
        Ok(v as u32)
    }
    fn bits(&mut self, n: u32) -> Result<u32, &'static str> {
        let mut v = 0u32;
        for k in 0..n { v |= self.bit()? << k; }
        Ok(v)
    }
}

/// Canonical Huffman code as in zlib's puff: symbols sorted by code length, decoded bit by bit.
// Huff::new and Huff::decode are adapted from puff's construct()
// and decode() implementations.
// Original code: Copyright (C) 2002-2013 Mark Adler, all rights reserved.
// Modified for shotq: translated to Rust for the DEFLATE stream walker.
// The adapted portions are distributed under the license in puff.h.
// See LICENSES/puff.txt and THIRD_PARTY_NOTICES.md.
struct Huff { count: [u16; 16], symbol: Vec<u16> }
impl Huff {
    fn new(lengths: &[u8]) -> Result<Huff, &'static str> {
        let mut count = [0u16; 16];
        for &l in lengths { count[l as usize] += 1; }
        count[0] = 0;
        let mut left = 1i32;
        for len in 1..16 { left <<= 1; left -= count[len] as i32; if left < 0 { return Err("over-subscribed Huffman code"); } }
        let mut offs = [0u16; 16];
        for len in 1..15 { offs[len + 1] = offs[len] + count[len]; }
        let mut symbol = vec![0u16; lengths.len()];
        for (sym, &l) in lengths.iter().enumerate() { if l != 0 { symbol[offs[l as usize] as usize] = sym as u16; offs[l as usize] += 1; } }
        Ok(Huff { count, symbol })
    }
    fn decode(&self, b: &mut Bits) -> Result<u16, &'static str> {
        let (mut code, mut first, mut index) = (0i32, 0i32, 0i32);
        for len in 1..16 {
            code |= b.bit()? as i32;
            let count = self.count[len] as i32;
            if code - count < first { return Ok(self.symbol[(index + (code - first)) as usize]); }
            index += count; first += count; first <<= 1; code <<= 1;
        }
        Err("invalid Huffman code")
    }
}

/// Walks a complete raw deflate stream. Returns (bit index of the last block's BFINAL, bit index just after its
/// data, decoded length).
pub fn walk(d: &[u8]) -> Result<(usize, usize, usize), &'static str> {
    let mut b = Bits { d, pos: 0 };
    let mut out = 0usize;
    let fixed_lit = Huff::new(&[[8u8; 144].as_slice(), &[9u8; 112], &[7u8; 24], &[8u8; 8]].concat())?;
    let fixed_dist = Huff::new(&[5u8; 32])?;
    loop {
        let hdr = b.pos;
        let bfinal = b.bit()?;
        let btype = b.bits(2)?;
        match btype {
            0 => {
                b.pos = (b.pos + 7) & !7;
                let len = b.bits(16)? as usize; let nlen = b.bits(16)? as usize;
                if len != (!nlen & 0xFFFF) { return Err("stored block length check failed"); }
                if (b.pos >> 3) + len > d.len() { return Err("truncated stored block"); }
                b.pos += 8 * len; out += len;
            }
            1 | 2 => {
                let (lit, dist);
                let (lit_ref, dist_ref) = if btype == 1 { (&fixed_lit, &fixed_dist) } else {
                    let hlit = b.bits(5)? as usize + 257; let hdist = b.bits(5)? as usize + 1; let hclen = b.bits(4)? as usize + 4;
                    let mut cl = [0u8; 19];
                    for k in 0..hclen { cl[CL_ORDER[k]] = b.bits(3)? as u8; }
                    let clh = Huff::new(&cl)?;
                    let mut lens: Vec<u8> = Vec::with_capacity(hlit + hdist);
                    while lens.len() < hlit + hdist {
                        let s = clh.decode(&mut b)?;
                        match s {
                            0..=15 => lens.push(s as u8),
                            16 => { let prev = *lens.last().ok_or("repeat with no previous length")?; for _ in 0..3 + b.bits(2)? { lens.push(prev); } }
                            17 => { for _ in 0..3 + b.bits(3)? { lens.push(0); } }
                            _ => { for _ in 0..11 + b.bits(7)? { lens.push(0); } }
                        }
                    }
                    if lens.len() > hlit + hdist { return Err("code lengths overrun"); }
                    lit = Huff::new(&lens[..hlit])?; dist = Huff::new(&lens[hlit..])?;
                    (&lit, &dist)
                };
                loop {
                    let sym = lit_ref.decode(&mut b)?;
                    if sym < 256 { out += 1; continue; }
                    if sym == 256 { break; }
                    let li = sym as usize - 257;
                    if li >= 29 { return Err("invalid length code"); }
                    let length = LEN_BASE[li] as usize + b.bits(LEN_EXTRA[li] as u32)? as usize;
                    let ds = dist_ref.decode(&mut b)? as usize;
                    if ds >= 30 { return Err("invalid distance code"); }
                    b.bits(DIST_EXTRA[ds] as u32)?;
                    out += length;
                }
            }
            _ => return Err("reserved block type"),
        }
        if bfinal == 1 { return Ok((hdr, b.pos, out)); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn lcg(seed: &mut u64) -> u32 { *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (*seed >> 33) as u32 }

    /// Screen-like rows: a filter byte, flat runs, and repeated "glyphs" with anti-aliasing-like variation.
    fn screen(rows: usize, row: usize, seed: u64) -> Vec<u8> {
        let mut s = seed; let mut v = Vec::with_capacity(rows * row);
        let glyphs: Vec<Vec<u8>> = (0..40).map(|_| (0..12).map(|_| (lcg(&mut s) % 200) as u8).collect()).collect();
        for y in 0..rows {
            v.push(0);
            let mut x = 1;
            while x < row {
                let r = lcg(&mut s) % 100;
                if r < 60 { let n = (8 + lcg(&mut s) % 200) as usize; let c = (lcg(&mut s) % 6) as u8; for _ in 0..n.min(row - x) { v.push(c); } x += n; }
                else { let g = &glyphs[(lcg(&mut s) % 40) as usize]; let tweak = (y % 3 == 0 && lcg(&mut s) % 4 == 0) as u8; for &q in g { if x < row { v.push(q + tweak); x += 1; } } }
            }
            v.truncate((y + 1) * row);
        }
        v
    }

    fn inflate_both(z: &[u8], expect: usize) -> (Vec<u8>, Vec<u8>) {
        let mut a = Vec::new();
        flate2::read::ZlibDecoder::new(z).read_to_end(&mut a).expect("zlib-rs inflate");
        let mut bbuf = vec![0u8; expect + 1];
        let n = libdeflater::Decompressor::new().zlib_decompress(z, &mut bbuf).expect("libdeflate inflate");
        bbuf.truncate(n);
        (a, bbuf)
    }

    #[test]
    fn joined_stream_inflates_with_two_decoders() {
        // several row-aligned chunks of screen content, at levels 6, 9 and 12
        let row = 1001; let raw = screen(900, row, 7);   // ~900 KB -> 64 KB chunks -> 14 fragments
        for level in [6, 9, 12] {
            let z = libdeflate_parallel(&raw, level, row);
            let (a, b) = inflate_both(&z, raw.len());
            assert!(a == raw && b == raw, "level {level}");
            let chunk = chunk_rows(raw.len(), row);
            assert_eq!(chunk % row, 0); assert!(chunk + row > 64 << 10 && chunk <= 256 << 10, "whole rows, within one row of the 64-256 KB rule");
        }
        // incompressible data: libdeflate emits stored blocks inside the fragments
        let mut s = 99u64; let noise: Vec<u8> = (0..300_000).map(|_| lcg(&mut s) as u8).collect();
        let z = libdeflate_parallel(&noise, 9, 1000);
        let (a, b) = inflate_both(&z, noise.len()); assert!(a == noise && b == noise);
        // a single short chunk (no fragment is patched), and an empty image row set
        let small = screen(20, 301, 3);
        let z = libdeflate_parallel(&small, 9, 301);
        let (a, b) = inflate_both(&z, small.len()); assert!(a == small && b == small);
    }

    #[test]
    fn nonfinal_fragments_cover_every_bit_phase() {
        // random lengths and contents: every phase p (0..8) of the data end must occur and every join must inflate
        let mut s = 5u64; let mut seen = [false; 8];
        let mut c = libdeflater::Compressor::new(libdeflater::CompressionLvl::new(9).unwrap());
        for k in 0..300 {
            let n = 1 + (lcg(&mut s) % if k % 2 == 0 { 3000 } else { 40 }) as usize;
            let a: Vec<u8> = if k % 3 == 0 { (0..n).map(|_| lcg(&mut s) as u8).collect() } else { screen(1, n, k as u64) };
            let b: Vec<u8> = screen(1, 1 + (lcg(&mut s) % 500) as usize, k as u64 + 1000);
            let mut fa = vec![0u8; c.deflate_compress_bound(a.len()) + 8]; let na = c.deflate_compress(&a, &mut fa).unwrap(); fa.truncate(na);
            let mut fb = vec![0u8; c.deflate_compress_bound(b.len()) + 8]; let nb = c.deflate_compress(&b, &mut fb).unwrap(); fb.truncate(nb);
            let p = make_nonfinal(&mut fa, a.len()).unwrap(); seen[p] = true;
            // the patched fragment must itself walk as "not final" up to the empty stored block, whose header is the
            // first BFINAL=0 block after the data; walking the joined stream must find exactly a.len() + b.len() bytes
            let mut joined = fa.clone(); joined.extend_from_slice(&fb);
            let (_, _, total) = walk(&joined).unwrap();
            assert_eq!(total, a.len() + b.len(), "k {k}");
            let mut z = vec![0x78, 0xDA]; z.extend_from_slice(&joined);
            let mut all = a.clone(); all.extend_from_slice(&b);
            z.extend_from_slice(&simd_adler32::adler32(&all.as_slice()).to_be_bytes());
            let (x, y) = inflate_both(&z, all.len()); assert!(x == all && y == all, "k {k}");
        }
        assert!(seen.iter().all(|&v| v), "bit phases seen: {seen:?}");
    }

    #[test]
    fn walk_reports_length_and_final_block() {
        let raw = screen(50, 777, 11);
        let mut c = libdeflater::Compressor::new(libdeflater::CompressionLvl::new(9).unwrap());
        let mut f = vec![0u8; c.deflate_compress_bound(raw.len()) + 8]; let n = c.deflate_compress(&raw, &mut f).unwrap(); f.truncate(n);
        let (hdr, end, len) = walk(&f).unwrap();
        assert_eq!(len, raw.len());
        assert_eq!((f[hdr >> 3] >> (hdr & 7)) & 1, 1, "BFINAL of the last block is set");
        assert_eq!((end + 7) >> 3, f.len(), "the stream ends right after the last block");
        assert!(walk(&f[..f.len() - 1]).is_err(), "a truncated stream is refused");
        // the length check of make_nonfinal
        let mut g = f.clone(); assert!(make_nonfinal(&mut g, raw.len() + 1).is_err());
    }

    #[test]
    fn compressor_reuse_is_deterministic() {
        // the same chunk compressed by a fresh compressor and by one that just did other work gives the same bytes
        let lvl = libdeflater::CompressionLvl::new(9).unwrap();
        let a = screen(60, 640, 1); let other = screen(80, 333, 2);
        let mut fresh = libdeflater::Compressor::new(lvl);
        let mut fa = vec![0u8; fresh.deflate_compress_bound(a.len())]; let na = fresh.deflate_compress(&a, &mut fa).unwrap(); fa.truncate(na);
        let mut used = libdeflater::Compressor::new(lvl);
        let mut fo = vec![0u8; used.deflate_compress_bound(other.len())]; used.deflate_compress(&other, &mut fo).unwrap();
        let mut fb = vec![0u8; used.deflate_compress_bound(a.len())]; let nb = used.deflate_compress(&a, &mut fb).unwrap(); fb.truncate(nb);
        assert_eq!(fa, fb);
        // and the whole parallel stream does not depend on the number of rayon threads
        let raw = screen(400, 1001, 21);
        let z16 = libdeflate_parallel(&raw, 9, 1001);
        let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
        let z1 = pool.install(|| libdeflate_parallel(&raw, 9, 1001));
        assert_eq!(z16, z1);
    }
}
