# Source of `cloud.spec.json`

`cloud.spec.json` is the Hetzner Cloud API specification, published by Hetzner Online GmbH.
It is not covered by this project's MIT License; see [`NOTICE`](../NOTICE).

- URL: https://docs.hetzner.cloud/cloud.spec.json (the `SPEC_URL` of
  `scripts/refresh-spec.ts`)
- Fetched: 2026-10-27 or earlier, with `npm run refresh-spec` (the commit date of the refresh; no fetch log was kept)
- OpenAPI version: 3.1.2, `info.title` "Hetzner Cloud API", `info.version` "1.0.0"
- SHA-256 of the committed file: `d4df975c1963c9d6291d2eeffd8aea89f6a8175210d2a14a0b713fc89f889406`
- Changes: none except formatting; `scripts/refresh-spec.ts` parses the download and writes it
  back as JSON with two-space indentation and a trailing newline.

`tests/notice.test.ts` fails when the committed file no longer matches the SHA-256 above.
After `npm run refresh-spec`, update the date and the SHA-256 here in the same commit
(`shasum -a 256 specs/cloud.spec.json`), then run `npm run generate` (see "Spec Updates" in
`README.md`).
