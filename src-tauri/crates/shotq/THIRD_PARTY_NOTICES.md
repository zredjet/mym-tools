# Third-party notices

shotq is licensed under the MIT License or the Apache License 2.0, at your option (`LICENSE-MIT`,
`LICENSE-APACHE`). That covers the code written for shotq. Two small pieces of `src/` are translations of
third-party C code and stay under their original licences: they are listed first, under "Code adapted into
shotq's source", and the original licence texts are kept verbatim in `LICENSES/`. A binary of the default build
(`cargo build --release`, no features) also statically links the crates listed after that. Ship this file together
with `LICENSE-MIT`, `LICENSE-APACHE` and the `LICENSES/` directory when you distribute a binary or the source.
Crate versions are those in `Cargo.lock` for shotq 0.23.2 (unchanged since 0.15.0; re-checked with `cargo tree`
on 2026-09-21); the list was generated from `cargo tree` and each crate's licence files on 2026-09-19.

## Code adapted into shotq's source

Each piece below is marked in the source by a comment directly above it that names the origin, the copyright
holder and what was changed. The zlib and puff licences ask that altered versions be plainly marked as such, that
the origin not be misrepresented, and that the notice be kept in source distributions; the comments, this section
and `LICENSES/` are how shotq meets those three conditions. Where the exact upstream version the translation was
made from is not known, that is stated as "not recorded", separately from the version used to verify the
correspondence.

### `adler32_combine` in `src/lib.rs` — from zlib's `adler32.c`

| | |
|---|---|
| Original project, file, function | zlib — `adler32.c` — `adler32_combine_()` (the body behind `adler32_combine()` and `adler32_combine64()`) |
| Where in shotq | `fn adler32_combine(a1: u32, a2: u32, len2: u32) -> u32` in `src/lib.rs` (`src/main.rs` until the library split), added in commit 32fdce0 (2026-09-19, parallel deflate P6); also called from `src/deflate.rs` |
| Author and copyright notice | Mark Adler. `adler32.c`: `Copyright (C) 1995-2011, 2016 Mark Adler`, "For conditions of distribution and use, see copyright notice in zlib.h". `zlib.h`: `Copyright (C) 1995-2024 Jean-loup Gailly and Mark Adler` |
| Source URL | https://github.com/madler/zlib (file `adler32.c`) |
| Upstream version the translation was made from | Not recorded |
| Version used to verify the correspondence | zlib 1.3.1 — tag `v1.3.1`, commit `51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf` — checked 2026-09-21: the Rust body follows `adler32_combine_` of that version statement by statement |
| Changes made for shotq | Translated from C to Rust. The length parameter is `u32` rather than `z_off64_t`, so the negative-length guard (return `0xffffffff`) is gone and the `MOD63(len2)` reduction is `len2 % BASE`; `MOD(sum2)` is `% BASE`; all arithmetic is `u32` rather than `unsigned long` (`rem * sum1` cannot overflow: both factors are below 2^16). The formula, the order of operations and the four conditional subtractions are unchanged. |
| Licence | zlib licence — full text in `LICENSES/zlib.txt` |

### `Huff::new` and `Huff::decode` in `src/deflate.rs` — from zlib's puff

| | |
|---|---|
| Original project, file, functions | puff (Mark Adler's reference inflater, shipped as `contrib/puff` in zlib) — `puff.c` — `construct()` and the bit-at-a-time `decode()` (the `#ifdef SLOW` variant) |
| Where in shotq | `impl Huff { fn new, fn decode }` in `src/deflate.rs`, added in commit 5d5d2ce (2026-09-20, libdeflate stream join P32). Only these two functions are adapted; the rest of the walker (`walk()` and the length, distance and code-length-order tables) implements RFC 1951 sections 3.2.5-3.2.7 and is not marked as adapted. |
| Author and copyright notice | Mark Adler. `puff.c`: `Copyright (C) 2002-2013 Mark Adler`, "For conditions of distribution and use, see copyright notice in puff.h". `puff.h`: `Copyright (C) 2002-2013 Mark Adler, all rights reserved`, version 2.3, 21 Jan 2013 |
| Source URL | https://github.com/madler/zlib/tree/master/contrib/puff (files `puff.c`, `puff.h`) |
| Upstream version the translation was made from | Not recorded |
| Version used to verify the correspondence | puff 2.3 (21 Jan 2013) as shipped in zlib 1.3.1 — tag `v1.3.1`, commit `51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf` — checked 2026-09-21 |
| Changes made for shotq | Translated from C to Rust. `Huff::new` (from `construct()`): counts and offsets are `[u16; 16]`, the symbol table is a `Vec<u16>` sized to the input; an over-subscribed length set returns `Err` instead of a negative count; `count[0]` is zeroed and the "no codes" early return and the incomplete-set return value (`left > 0`) are dropped, because the walker only re-traces streams that libdeflate has just produced. `Huff::decode` (from the `SLOW` `decode()`): reads bits through the walker's `Bits` reader and returns `Err` where puff returns -10. |
| Licence | The licence in `puff.h` (zlib-style, single author) — full text in `LICENSES/puff.txt` |

## Zlib licence

- **zlib-rs 0.6.8** — (C) 2024 Trifecta Tech Foundation — https://github.com/trifectatechfoundation/zlib-rs

```
This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.

2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.

3. This notice may not be removed or altered from any source distribution.
```

## MIT licence

The permission notice below applies to every component in this section, with the copyright lines given.

- **libdeflate** (C library, compiled in by libdeflate-sys 1.26.1) — Copyright 2016 Eric Biggers; Copyright 2024
  Google LLC — https://github.com/ebiggers/libdeflate
- **qcms 0.3.0** — Copyright (C) 2009 Mozilla Foundation; Copyright (C) 1998-2007 Marti Maria —
  https://github.com/FirefoxGraphics/qcms (the colour management library of Firefox; converts the palette from the
  input's ICC profile to sRGB)
- **rgb 0.8.53** — Copyright (c) 2019 Kornel — https://github.com/kornelski/rust-rgb
- **simd-adler32 0.3.10** — Copyright (c) 2021 Marvin Countryman — https://github.com/mcountryman/simd-adler32
- **libc 0.2.189** — Copyright (c) The Rust Project Developers — MIT OR Apache-2.0, used under MIT —
  https://github.com/rust-lang/libc
- **adler2 2.0.1** — Copyright (C) Jonas Schievink — 0BSD OR MIT OR Apache-2.0, used under MIT —
  https://github.com/oyvindln/adler2
- **miniz_oxide 0.8.9 and 0.9.1** — Copyright (c) 2017 Frommi; derived from miniz: Copyright 2013-2014 RAD Game
  Tools and Valve Software, Copyright 2010-2014 Rich Geldreich and Tenacious Software LLC — MIT OR Zlib OR
  Apache-2.0, used under MIT — https://github.com/Frommi/miniz_oxide
- **bytemuck 1.25.2** — Copyright (c) 2019 Daniel "Lokathor" Gee — Zlib OR Apache-2.0 OR MIT, used under MIT —
  https://github.com/Lokathor/bytemuck
- **bitflags 2.13.2, cfg-if 1.0.5, crc32fast 1.5.2, crossbeam-deque 0.8.8, crossbeam-epoch 0.9.21,
  crossbeam-utils 0.8.23, either 1.18.0, fdeflate 0.3.7, flate2 1.1.10, png 0.18.1, rayon 1.12.0,
  rayon-core 1.13.0** — MIT OR Apache-2.0, used under MIT. Their `LICENSE-MIT` files carry the permission notice
  without an individual copyright line. Repositories: https://github.com/bitflags/bitflags,
  https://github.com/rust-lang/cfg-if, https://github.com/srijs/rust-crc32fast,
  https://github.com/crossbeam-rs/crossbeam, https://github.com/rayon-rs/either,
  https://github.com/image-rs/fdeflate, https://github.com/rust-lang/flate2-rs, https://github.com/image-rs/image-png,
  https://github.com/rayon-rs/rayon

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Apache License 2.0

- **libdeflater 1.26.1** and **libdeflate-sys 1.26.1** — https://github.com/libdeflater/libdeflater — the Rust
  binding to libdeflate (the C code itself is MIT, listed above). These crates ship no NOTICE file. The full
  licence text is in `LICENSE-APACHE`.

## Not part of the default build

- **imagequant 4.4.1** (libimagequant) — GPL-3.0-or-later — linked only when shotq is built with
  `--features liq` for A/B comparison. Such a binary is covered by the GPL and must not be distributed under the
  notices above.
