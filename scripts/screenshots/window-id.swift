// MyMyTools のウィンドウの CGWindowID を表示する (`screencapture -l` に渡す)。
// 使い方: swift scripts/screenshots/window-id.swift
import CoreGraphics

let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
  as? [[String: Any]] ?? []
for window in windows where window[kCGWindowOwnerName as String] as? String == "MyMyTools" {
  if window[kCGWindowLayer as String] as? Int == 0, let id = window[kCGWindowNumber as String] as? Int {
    print(id)
  }
}
