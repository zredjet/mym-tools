/** Frontend / Backend のモジュール登録を起動時に照合する IPC。 */
import { invoke } from "@tauri-apps/api/core";

export function getBackendModuleIds(): Promise<string[]> {
  return invoke<string[]>("core_module_ids");
}
