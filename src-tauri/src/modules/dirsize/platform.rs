//! OS ごとに違う部分 (ADR-0025): ローカルのボリュームか、ディスク上の大きさ、ハードリンク、
//! ドライブの使用量。
//!
//! Windows の部分は CI の Windows ビルドでだけコンパイルされ、テストは Linux / macOS で走る。
//! 文字列だけで決まる判定 (`drive_root` / `is_drive_root`) は全 OS でテストできるよう分けている。

use std::fs::{DirEntry, Metadata};
use std::path::Path;

use super::scan::VolumeUsage;

/// フォルダがある装置の識別子 (Unix の `st_dev`)。別のボリュームへ入らないために比べる。
/// Windows のマウントポイントはジャンクションと同じくリンクとして辿らないので比べない。
#[cfg(unix)]
pub(super) fn device_id(metadata: &Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    Some(metadata.dev())
}

#[cfg(not(unix))]
pub(super) fn device_id(_metadata: &Metadata) -> Option<u64> {
    None
}

/// ハードリンクを 1 回だけ数えるための鍵 (Unix の `(st_dev, st_ino)`)。リンクが 1 本なら `None`。
/// Windows はファイルを開かないと分からないため数えない (ADR-0025)。
#[cfg(unix)]
pub(super) fn hard_link_key(metadata: &Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    (metadata.nlink() > 1).then(|| (metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
pub(super) fn hard_link_key(_metadata: &Metadata) -> Option<(u64, u64)> {
    None
}

/// ルートがネットワーク上のボリュームなら、拒否する理由を返す。UNC などの文字列で分かるものは
/// 呼び出し側が先に `network_path::is_network_path` で拒否している。
#[cfg(target_os = "macos")]
pub(super) fn ensure_local_volume(root: &Path) -> Result<(), String> {
    use std::ffi::CString;
    use std::mem::MaybeUninit;
    use std::os::unix::ffi::OsStrExt;

    let Ok(path) = CString::new(root.as_os_str().as_bytes()) else {
        return Err("フォルダのパスに使えない文字が含まれています。".into());
    };
    let mut stat = MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: path は NUL 終端で、stat は statfs 構造体の大きさの領域。呼び出しの間どちらも生きている。
    if unsafe { libc::statfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        // 存在しない等は、続く metadata() のエラーとして伝える
        return Ok(());
    }
    // SAFETY: statfs が 0 を返したので stat は初期化済み
    let stat = unsafe { stat.assume_init() };
    if stat.f_flags & (libc::MNT_LOCAL as u32) == 0 {
        return Err(
            "ネットワーク上のボリュームは対象外です。ローカルのフォルダを指定してください。".into(),
        );
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn ensure_local_volume(root: &Path) -> Result<(), String> {
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    /// `Win32_System_WindowsProgramming` feature を足さないため値をここに置く
    const DRIVE_REMOTE: u32 = 4;

    let Some(drive) = root.to_str().and_then(drive_root) else {
        return Err("ドライブ文字 (C:\\ など) で始まるフォルダを指定してください。".into());
    };
    let wide = to_wide(&drive);
    // SAFETY: 終端 NUL 付きのバッファが呼び出しの間生きている
    if unsafe { GetDriveTypeW(wide.as_ptr()) } == DRIVE_REMOTE {
        return Err(
            "ネットワークドライブは対象外です。ローカルのフォルダを指定してください。".into(),
        );
    }
    Ok(())
}

/// Linux は配布対象外で、CI のテストでだけ動く。
#[cfg(not(any(windows, target_os = "macos")))]
pub(super) fn ensure_local_volume(_root: &Path) -> Result<(), String> {
    Ok(())
}

/// ファイルの「ディスク上」の大きさを求める (ADR-0025)。フォルダ自身の領域は数えない。
pub(super) struct Allocation {
    /// クラスタの大きさ。取れなければ `len` をそのまま使う
    #[cfg(windows)]
    cluster_size: Option<u64>,
}

#[cfg(unix)]
impl Allocation {
    pub(super) fn for_root(_root: &Path) -> Self {
        Self {}
    }

    /// `st_blocks` は macOS / Linux とも 512 バイト単位
    pub(super) fn allocated_size(&self, _entry: &DirEntry, metadata: &Metadata) -> u64 {
        use std::os::unix::fs::MetadataExt;
        metadata.blocks().saturating_mul(512)
    }
}

#[cfg(windows)]
impl Allocation {
    pub(super) fn for_root(root: &Path) -> Self {
        let cluster_size = root
            .to_str()
            .and_then(drive_root)
            .and_then(|drive| cluster_size(&drive));
        Self { cluster_size }
    }

    /// 圧縮・スパース・クラウド上だけにあるファイルは `GetCompressedFileSizeW` で実際の領域を
    /// 問い合わせ、それ以外は `len` をクラスタの大きさへ切り上げる。属性は親フォルダの一覧
    /// (FindNextFile) から取れるので、ファイル自体は開かない。
    pub(super) fn allocated_size(&self, entry: &DirEntry, metadata: &Metadata) -> u64 {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_SPARSE_FILE: u32 = 0x200;
        const FILE_ATTRIBUTE_COMPRESSED: u32 = 0x800;
        const FILE_ATTRIBUTE_OFFLINE: u32 = 0x1000;
        const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x4_0000;
        const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x40_0000;
        const QUERY_ATTRIBUTES: u32 = FILE_ATTRIBUTE_SPARSE_FILE
            | FILE_ATTRIBUTE_COMPRESSED
            | FILE_ATTRIBUTE_OFFLINE
            | FILE_ATTRIBUTE_RECALL_ON_OPEN
            | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;

        let len = metadata.len();
        if metadata.file_attributes() & QUERY_ATTRIBUTES != 0 {
            if let Some(size) = compressed_file_size(&entry.path()) {
                return size;
            }
        }
        match self.cluster_size {
            Some(cluster) => len.div_ceil(cluster).saturating_mul(cluster),
            None => len,
        }
    }
}

/// ドライブ直下を走査した時だけ、ドライブ全体の大きさと使用量を返す (ADR-0025)。
/// macOS は APFS のボリュームがコンテナの空きを共有し、差を出すと誤解を生むため返さない。
#[cfg(windows)]
pub(super) fn volume_usage(root_path: &str) -> Option<VolumeUsage> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    if !is_drive_root(root_path) {
        return None;
    }
    let wide = to_wide(&drive_root(root_path)?);
    let (mut available, mut total, mut free) = (0u64, 0u64, 0u64);
    // SAFETY: 終端 NUL 付きのバッファと出力先の変数が呼び出しの間生きている
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    (ok != 0).then(|| VolumeUsage {
        total_bytes: total,
        used_bytes: total.saturating_sub(free),
    })
}

#[cfg(not(windows))]
pub(super) fn volume_usage(_root_path: &str) -> Option<VolumeUsage> {
    None
}

/// `X:\` か `X:/` で始まるパスの、ドライブのルート (`X:\`)。
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn drive_root(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let is_drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    is_drive.then(|| format!("{}:\\", char::from(bytes[0].to_ascii_uppercase())))
}

/// ドライブ直下 (`X:\`) を指すパスか。末尾の区切りはいくつあってもよい。
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn is_drive_root(path: &str) -> bool {
    // drive_root が Some なら先頭 2 バイトは ASCII なので、2 バイト目で切ってよい
    drive_root(path).is_some() && path[2..].chars().all(|c| matches!(c, '\\' | '/'))
}

#[cfg(windows)]
fn to_wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

#[cfg(windows)]
fn cluster_size(drive: &str) -> Option<u64> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceW;

    let wide = to_wide(drive);
    let (mut sectors, mut bytes, mut free, mut total) = (0u32, 0u32, 0u32, 0u32);
    // SAFETY: 終端 NUL 付きのバッファと出力先の変数が呼び出しの間生きている
    let ok = unsafe {
        GetDiskFreeSpaceW(
            wide.as_ptr(),
            &mut sectors,
            &mut bytes,
            &mut free,
            &mut total,
        )
    };
    let size = u64::from(sectors) * u64::from(bytes);
    (ok != 0 && size > 0).then_some(size)
}

#[cfg(windows)]
fn compressed_file_size(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetCompressedFileSizeW;
    const INVALID_FILE_SIZE: u32 = u32::MAX;

    let wide: Vec<u16> = long_path(path).encode_wide().chain(Some(0)).collect();
    let mut high = 0u32;
    // SAFETY: 終端 NUL 付きのバッファと出力先の変数が呼び出しの間生きている
    let low = unsafe { GetCompressedFileSizeW(wide.as_ptr(), &mut high) };
    // 戻り値が INVALID_FILE_SIZE でも、直後の GetLastError が 0 なら正しい値
    if low == INVALID_FILE_SIZE && std::io::Error::last_os_error().raw_os_error() != Some(0) {
        return None;
    }
    Some((u64::from(high) << 32) | u64::from(low))
}

/// MAX_PATH (260) 以上のパスは `\\?\` を付けないと Win32 API が受け付けない。
/// std の fs 関数は自分で付けるが、ここは Win32 API を直接呼ぶので付ける。
#[cfg(windows)]
fn long_path(path: &Path) -> std::ffi::OsString {
    const MAX_PATH: usize = 260;
    match path.to_str() {
        Some(text) if text.len() >= MAX_PATH && drive_root(text).is_some() => {
            format!(r"\\?\{}", text.replace('/', "\\")).into()
        }
        _ => path.as_os_str().to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drive_root_takes_the_drive_letter() {
        assert_eq!(drive_root(r"C:\Users\x"), Some(r"C:\".into()));
        assert_eq!(drive_root("d:/data"), Some(r"D:\".into()));
        assert_eq!(drive_root(r"C:\"), Some(r"C:\".into()));
        assert_eq!(drive_root("C:"), None);
        assert_eq!(drive_root(r"\\server\share"), None);
        assert_eq!(drive_root("/Users/x"), None);
        assert_eq!(drive_root(""), None);
        assert_eq!(drive_root("あ:/x"), None);
    }

    #[test]
    fn drive_root_paths_are_detected() {
        for path in [r"C:\", "C:/", r"c:\\", r"D:\/"] {
            assert!(is_drive_root(path), "{path}");
        }
        for path in [r"C:\Users", "C:", r"C:\x\", "/", r"\\server\share\"] {
            assert!(!is_drive_root(path), "{path}");
        }
    }
}
