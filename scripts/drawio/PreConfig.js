/**
 * MyMyTools offline override for draw.io 31.4.1.
 *
 * Upstream `js/PreConfig.js` is replaced at build time. This modified copy keeps the
 * Apache-2.0 copyright notices and removes every server endpoint from the runtime.
 * The loopback asset origin allows only same-origin client asset requests and blocks
 * every external network origin.
 *
 * Copyright (c) 2006-2024, JGraph Holdings Ltd
 * Copyright (c) 2006-2024, draw.io AG
 */
/* global urlParams */
window.DRAWIO_PUBLIC_BUILD = true;
window.EXPORT_URL = null;
window.DRAWIO_BASE_URL = ".";
window.DRAWIO_VIEWER_URL = null;
window.DRAWIO_LIGHTBOX_URL = null;
window.DRAW_MATH_URL = "math4/es5";
window.DRAWIO_CONFIG = {
  version: "mym-tools-offline-v1",
  telemetry: false,
  enableCssDarkMode: true,
  lockdown: true,
  suppressNewWindows: true,
  enableLocalFonts: false,
  inlineExtIcons: true,
  useInternalClipboard: true,
};

urlParams["sync"] = "manual";
urlParams["offline"] = "1";
urlParams["local"] = "1";
urlParams["analytics"] = "0";
