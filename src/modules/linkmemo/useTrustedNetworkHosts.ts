/** 確認せずに開くサーバ (`modules.linkmemo.trusted_network_hosts`) の読み書き。 */
import { useCallback, useMemo } from "react";

import { TRUSTED_NETWORK_HOSTS_KEY, parseTrustedHosts } from "@/modules/linkmemo/networkTrust";
import { useAppStore } from "@/store/useAppStore";

export function useTrustedNetworkHosts() {
  const raw = useAppStore((state) => state.moduleSettings["linkmemo"]?.[TRUSTED_NETWORK_HOSTS_KEY]);
  const setModuleSetting = useAppStore((state) => state.setModuleSetting);
  const hosts = useMemo(() => parseTrustedHosts(raw), [raw]);

  const trust = useCallback(
    (host: string) => {
      if (hosts.includes(host)) return;
      setModuleSetting("linkmemo", TRUSTED_NETWORK_HOSTS_KEY, [...hosts, host]);
    },
    [hosts, setModuleSetting],
  );
  const untrust = useCallback(
    (host: string) =>
      setModuleSetting(
        "linkmemo",
        TRUSTED_NETWORK_HOSTS_KEY,
        hosts.filter((item) => item !== host),
      ),
    [hosts, setModuleSetting],
  );
  return { hosts, trust, untrust };
}
