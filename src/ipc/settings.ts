/** `settings.json` 用 Tauri IPC ラッパー。 */
import { invoke } from "@tauri-apps/api/core";

import type { SettingsDocument } from "@/lib/settings";

export function getSettings(): Promise<SettingsDocument> {
  return invoke<SettingsDocument>("core_get_settings");
}

export function updateSettings(settings: SettingsDocument): Promise<void> {
  return invoke<void>("core_update_settings", { settings });
}
