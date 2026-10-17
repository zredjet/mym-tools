//! 走査するフォルダ (ルート) を確かめる (ADR-0025)。
//!
//! ネットワーク上の場所には触らない。Windows ではネットワーク上のパスに触れた時点で SMB 接続が
//! 走り、サインイン情報 (NTLM 認証) がサーバへ送られるため、次を確かめてからファイルシステムに触る。
//!
//! - パスの文字列 (UNC・device path)
//! - パスに含まれるリンク (シンボリックリンク・ジャンクション) の行き先。リンクは辿らずに
//!   `read_link` でリンク自体から行き先を読み、確かめてから次の部分へ進む
//! - ドライブ (Windows は `GetDriveTypeW`)。macOS は解決したパスの `statfs`

use std::ffi::OsString;
use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Component, Path, PathBuf, MAIN_SEPARATOR_STR};

use crate::error::AppError;
use crate::modules::network_path::is_network_path;

use super::platform;

const MODULE_ID: &str = "dirsize";
/// 解決するリンクの数の上限 (Linux の ELOOP と同じ)
const MAX_LINKS: usize = 40;
const NETWORK_REASON: &str =
    "ネットワーク上の場所は対象外です。ローカルのフォルダを指定してください。";

/// 確かめたルート。`path` はリンクを解決したパスで、走査はこちらをたどる
#[derive(Debug)]
pub(super) struct Root {
    pub path: PathBuf,
    pub metadata: fs::Metadata,
}

pub(super) fn validate_root(root_path: &str) -> Result<Root, AppError> {
    if root_path.trim().is_empty() {
        return Err(validation("フォルダを指定してください。"));
    }
    if is_network_path(root_path) {
        return Err(validation(NETWORK_REASON));
    }
    let root = Path::new(root_path);
    if !root.is_absolute() {
        return Err(validation("フォルダは絶対パスで指定してください。"));
    }
    let path = resolve_links(root)?;
    platform::ensure_local_volume(&path).map_err(validation)?;
    // リンクは解決済みなので、ここで辿るものはない
    let metadata = fs::metadata(&path).map_err(|error| read_error(&path, error))?;
    if !metadata.is_dir() {
        return Err(validation(
            "フォルダを指定してください。ファイルは対象外です。",
        ));
    }
    Ok(Root { path, metadata })
}

/// パスの部分。リンクの行き先を差し込めるよう、借用しない形で持つ
enum Part {
    Prefix(OsString),
    Root,
    Parent,
    Normal(OsString),
}

/// `path` の部分を、次に取り出す順で `pending` (末尾から取り出す) に積む
fn push_parts(pending: &mut Vec<Part>, path: &Path) {
    let parts: Vec<Part> = path
        .components()
        .filter_map(|component| match component {
            Component::Prefix(prefix) => Some(Part::Prefix(prefix.as_os_str().to_owned())),
            Component::RootDir => Some(Part::Root),
            Component::CurDir => None,
            Component::ParentDir => Some(Part::Parent),
            Component::Normal(name) => Some(Part::Normal(name.to_owned())),
        })
        .collect();
    pending.extend(parts.into_iter().rev());
}

/// パスに含まれるリンクを、行き先に触らずに 1 つずつ解決する。
///
/// 部分ごとに `symlink_metadata` (リンクを辿らない) で確かめ、リンクなら `read_link` で行き先を
/// 読む。行き先がネットワーク上の場所なら、そこへ触る前に拒否する。ドライブが変わる時は、
/// そのドライブに触る前に確かめる。`..` はリンクを解決した後のパスの親として扱う (OS と同じ)。
fn resolve_links(root: &Path) -> Result<PathBuf, AppError> {
    let mut pending = Vec::new();
    push_parts(&mut pending, root);
    let mut current = PathBuf::new();
    let mut links = 0;
    while let Some(part) = pending.pop() {
        match part {
            Part::Prefix(prefix) => {
                if let Some(Component::Prefix(component)) = Path::new(&prefix).components().next() {
                    platform::ensure_local_prefix(component.kind()).map_err(validation)?;
                }
                current = PathBuf::from(prefix);
            }
            Part::Root => {
                // ドライブ (Windows) は残し、その直下へ戻る
                let drive = match current.components().next() {
                    Some(Component::Prefix(prefix)) => PathBuf::from(prefix.as_os_str()),
                    _ => PathBuf::new(),
                };
                current = drive;
                current.push(MAIN_SEPARATOR_STR);
            }
            Part::Parent => {
                current.pop();
            }
            Part::Normal(name) => {
                let next = current.join(&name);
                let metadata =
                    fs::symlink_metadata(&next).map_err(|error| read_error(&next, error))?;
                // Windows ではジャンクション・マウントポイントも is_symlink
                if !metadata.file_type().is_symlink() {
                    current = next;
                    continue;
                }
                links += 1;
                if links > MAX_LINKS {
                    return Err(validation("リンクの入れ子が深すぎます。"));
                }
                let target = fs::read_link(&next).map_err(|error| read_error(&next, error))?;
                let target = local_link_target(&target).ok_or_else(|| {
                    validation(format!(
                        "リンクの行き先がローカルのフォルダではないため対象外です: {} → {}",
                        next.display(),
                        target.display()
                    ))
                })?;
                push_parts(&mut pending, &target);
            }
        }
    }
    Ok(current)
}

/// リンクの行き先がローカルにあり得るなら、たどれる形にして返す。ネットワーク上の場所に
/// なり得るもの (UNC・device path・ドライブ文字の無い `\\?\` パス) は `None`。
///
/// Windows の `read_link` はジャンクションの行き先を `\\?\C:\...` で返すので、ドライブ文字の
/// ある `\\?\` / `\??\` は前置きを除いて `C:\...` として扱う。
fn local_link_target(target: &Path) -> Option<PathBuf> {
    let Some(text) = target.to_str() else {
        return (!is_network_path(&target.to_string_lossy())).then(|| target.to_path_buf());
    };
    let stripped = strip_verbatim_disk(text);
    if is_network_path(stripped) {
        None
    } else {
        Some(PathBuf::from(stripped))
    }
}

/// ドライブ文字のある verbatim path (`\\?\C:\x`) と NT path (`\??\C:\x`) の前置きを除く
fn strip_verbatim_disk(text: &str) -> &str {
    for prefix in [r"\\?\", r"\??\"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            if platform::drive_root(rest).is_some() {
                return rest;
            }
        }
    }
    text
}

fn read_error(path: &Path, error: io::Error) -> AppError {
    match error.kind() {
        ErrorKind::NotFound => validation("フォルダが見つかりません。"),
        _ => AppError::Io(format!("{} を読めません: {error}", path.display())),
    }
}

fn validation(reason: impl Into<String>) -> AppError {
    AppError::Validation {
        module_id: MODULE_ID.into(),
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Prefix;

    fn reason(error: AppError) -> String {
        match error {
            AppError::Validation { reason, .. } => reason,
            other => panic!("expected validation error: {other:?}"),
        }
    }

    #[test]
    fn verbatim_disk_targets_are_local() {
        assert_eq!(
            local_link_target(Path::new(r"\\?\C:\Users\x\Music")),
            Some(PathBuf::from(r"C:\Users\x\Music"))
        );
        assert_eq!(
            local_link_target(Path::new(r"\??\D:\data")),
            Some(PathBuf::from(r"D:\data"))
        );
        assert_eq!(
            local_link_target(Path::new(r"C:\data")),
            Some(PathBuf::from(r"C:\data"))
        );
        assert_eq!(
            local_link_target(Path::new("../real")),
            Some(PathBuf::from("../real"))
        );
        assert_eq!(
            local_link_target(Path::new("/private/tmp")),
            Some(PathBuf::from("/private/tmp"))
        );
    }

    #[test]
    fn network_targets_are_rejected() {
        for target in [
            r"\\server\share",
            "//server/share",
            r"\\?\UNC\server\share",
            r"\??\UNC\server\share",
            r"\\?\Volume{00000000-0000-0000-0000-000000000000}\",
            r"\\.\pipe\x",
            r"\\?\GLOBALROOT\Device\Mup\server",
        ] {
            assert_eq!(local_link_target(Path::new(target)), None, "{target}");
        }
    }

    #[test]
    fn only_drive_letter_prefixes_are_local() {
        use std::ffi::OsStr;
        assert!(platform::ensure_local_prefix(Prefix::Disk(b'C')).is_ok());
        assert!(platform::ensure_local_prefix(Prefix::VerbatimDisk(b'C')).is_ok());
        for prefix in [
            Prefix::UNC(OsStr::new("server"), OsStr::new("share")),
            Prefix::VerbatimUNC(OsStr::new("server"), OsStr::new("share")),
            Prefix::Verbatim(OsStr::new("Volume{0}")),
            Prefix::DeviceNS(OsStr::new("pipe")),
        ] {
            assert!(platform::ensure_local_prefix(prefix).is_err(), "{prefix:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn links_to_local_folders_are_resolved() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        fs::create_dir_all(real.join("sub")).unwrap();
        symlink(&real, dir.path().join("absolute")).unwrap();
        symlink("real", dir.path().join("relative")).unwrap();
        symlink("absolute/../real", dir.path().join("chain")).unwrap();
        let canonical = fs::canonicalize(&real).unwrap();

        for link in ["absolute", "relative", "chain"] {
            let root = validate_root(dir.path().join(link).to_str().unwrap()).unwrap();
            assert_eq!(root.path, canonical, "{link}");
        }
        let through = validate_root(dir.path().join("relative/sub").to_str().unwrap()).unwrap();
        assert_eq!(through.path, canonical.join("sub"));
    }

    #[cfg(unix)]
    #[test]
    fn links_to_network_locations_are_rejected_before_following() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        symlink("//server/share", dir.path().join("nas")).unwrap();
        symlink(r"\\server\share", dir.path().join("unc")).unwrap();
        fs::create_dir(dir.path().join("real")).unwrap();
        symlink("../nas", dir.path().join("real/indirect")).unwrap();
        for path in ["nas", "unc", "nas/sub", "real/indirect"] {
            let error = validate_root(dir.path().join(path).to_str().unwrap()).unwrap_err();
            assert!(
                reason(error)
                    .starts_with("リンクの行き先がローカルのフォルダではないため対象外です"),
                "{path}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn link_loops_are_rejected() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        symlink("b", dir.path().join("a")).unwrap();
        symlink("a", dir.path().join("b")).unwrap();
        let error = validate_root(dir.path().join("a").to_str().unwrap()).unwrap_err();
        assert_eq!(reason(error), "リンクの入れ子が深すぎます。");
    }
}
