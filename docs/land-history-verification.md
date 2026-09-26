# Land History Verification

Date: 2026-09-26. Scope: Telegram satellite-history feature, not a field accuracy study.

## Live Data

Executed `node scripts/check-satellite.mjs 51.05 71.15 250` without Telegram credentials or case writes.

- Public test AOI: 51.05 N, 71.15 E; 500 x 500 m; EPSG:32642; 25 x 25 cells at 20 m.
- Before: `S2B_42UXB_20250925_0_L2A`, acquisition `2025-09-25T06:25:04.042000Z`.
- After: `S2B_42UXB_20260923_0_L2A`, acquisition `2026-09-23T06:34:59.762000Z`.
- 42 requests, including 40 bounded byte-range requests. No full-scene download.
- Common valid fraction: 1.0. Method result: `no_change`, 0 candidate hectares.
- Each native PNG had 625 opaque pixels; before/after had 558/554 distinct RGB colors.
- Inspected actual before/after PNGs enlarged using the same nearest-neighbor display function as Telegram. Both were nonblank, correspondingly framed and varied. This was not an inspection of the Telegram client.

An earlier live attempt failed. Investigation exposed legacy COG offset handling and baseline ordering issues; both received focused offline regressions before the successful repeat. `earthsearch:boa_offset_applied` is honored only with the recognized scale/offset convention; declared/applied radiometry is retained in analysis provenance. Known catalog metadata inconsistencies remain a data-quality risk, not grounds to infer corrections from image values.

References: [Earth Search metadata guidance](https://github.com/Element84/earth-search), [legacy offset issue](https://github.com/Element84/earth-search/issues/71), [reported metadata inconsistencies](https://github.com/Element84/earth-search/issues/66).

## Reproducible Checks

Full `npm.cmd test` on local Node 24 and `npx.cmd --yes node@22 --test` on the Railway runtime major: 280 passing tests each at this checkpoint, including existing bot regressions. Focused coverage includes:

- UTM alignment, scene masks, disconnected noise, valid fraction, contour holes and fractional outside area.
- Real TIFF decoding against synthetic range responses, bounded requests, host validation and cancellation.
- Explicit user consent, stale/double callbacks, private ownership, upload size caps and native-location behavior.
- Operator allowlisting, sharing revocation during delivery and decisions bound to the inspected analysis.
- Atomic real-store/service lifecycle, corruption preservation, two monitoring dates, pending delivery after restart and cancellation races.
- Verified contours with insufficient imagery, image enlargement without fabricated detail, and original event dates after later manual analysis.

`npm.cmd audit --omit=dev`: no vulnerabilities reported at this checkpoint.

## Remaining External Checks

- No trusted operator ID was supplied. Keep `TELEGRAM_OPERATOR_IDS` empty until the owner identifies and configures the operator via `/myid`.
- EGKN public HTML and WFS capabilities responded, but no permitted-work contour was supplied or independently verified. Automatic parcel/permit import is not implemented.
- Telegram interactions are exercised through synthetic updates; a user should still send an actual point and inspect the delivered media in their Telegram client.
- No claim of excavation-detection accuracy, official legal status, guaranteed weekly imagery or exactly-once Telegram delivery is made.

## Manual Acceptance

1. Send a real point, choose satellite history and area; verify the actual acquisition dates, sources and three images.
2. Cancel while acquisition is active; confirm the case remains in `/sites` without interrupting the new conversation.
3. Upload a documented contour and field photo. Confirm no outside-area conclusion appears before a trusted operator review.
4. Configure the trusted operator, share the case, inspect and record a reason. Revoke sharing and confirm new access is denied.
5. Close locally, explicitly enable weekly observation, then reopen or disable it. Confirm the setting survives service restart.
