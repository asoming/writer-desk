# Offline graph layout dependency

`dagre.min.js` is the unmodified browser bundle from **@dagrejs/dagre 1.1.8**, distributed under the MIT license. It includes **@dagrejs/graphlib 2.2.4**, also MIT. The corresponding license texts are preserved in `dagre.LICENSE` and `graphlib.LICENSE`.

- Upstream: https://github.com/dagrejs/dagre
- Package: https://registry.npmjs.org/@dagrejs/dagre/1.1.8
- Archive: https://registry.npmjs.org/@dagrejs/dagre/-/dagre-1.1.8.tgz
- Archive SHA-512 (npm integrity): `sha512-5SEDlndt4W/LaVzPYJW+bSmSEZc9EzTf8rJ20WCKvjS5EAZAN0b+x0Yww7VMT4R3Wootkg+X9bUfUxazYw6Blw==`

The archive integrity was checked before the browser bundle was extracted. The app loads this file locally and makes no runtime network requests. Dagre 1.1.8 is pinned because the endpoint regression test found an incorrect self-loop route in 3.1.1.

Load `vendor/dagre.min.js`, then `atlas-layout.js`, before the workspace renderer. The layout wrapper returns node center coordinates, edge points, and edge-label center coordinates in the same padded SVG coordinate system. It does not alter book data or create DOM nodes.
