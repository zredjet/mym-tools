# SVG-Edit runtime distribution

SVG-Edit 7.4.2 is pinned by npm package-lock.json integrity:
https://github.com/SVG-Edit/svgedit/tree/v7.4.2

Editor.js is the unchanged official ES Module distribution. MyMyTools supplies
a separate host adapter, shared SVG policy, and Japanese extension resources.
The asset manifest records every copied runtime file and SHA-256 digest.

NOTICES.txt contains license texts and original copyright notices. The reviewed
source-map inventory is in license-audit.json. It includes SVG-Edit/svgcanvas,
jGraduate, Elix, i18next and libraries embedded in svgcanvas, including the modern
jsPDF stack even though PDF export is not exposed. DOMPurify uses Apache-2.0;
rgbcolor uses MIT. Other selected components include MIT, BSD-style and Zlib
licenses. No source-delivery requirement was identified for these selections.

The package-wide upstream-licenseInfo.json also lists legacy ISC/LGPL/X11 files.
Its LGPL svgToPdf plugin and old X11 jsPDF are absent from the selected runtime.
Archives, tests, samples, IIFE bundles and source maps are not shipped. The maps
were read for the integration audit only. Recheck notices and source conditions
when changing the pinned distribution; do not infer its terms solely from MIT.
