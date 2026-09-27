# Land History Implementation Plan

> For agentic workers: use subagent-driven-development. The user approved all four connected capabilities in this conversation.

**Goal:** Real before/after satellite evidence, optional verified-boundary comparison, targeted field evidence and opt-in monitoring after local closure.

**Architecture:** Keep the existing report workflow. A private-chat satellite action attached to a received location creates a persistent land case. A bounded Earth Search/COG provider feeds deterministic GIS calculations; operators review evidence and boundaries; a single worker checks opted-in closed cases. Missing imagery and missing official context remain explicit unknowns.

**Tech Stack:** Node.js 22+, Telegraf, geotiff, proj4, Turf, pngjs, node:test, atomic JSON storage on /app/data.

**Spec:** The four approved requirements in the conversation; detailed contracts and acceptance criteria below are the implementation specification.

## Global Constraints

- Do not modify the user's existing .env.example edit or publish secrets.
- Do not start another polling instance of @zbjer_bot locally.
- Only explicit analysis consent sends an area to public satellite services; no names or Telegram IDs sent to those services.
- Sentinel-2 is not a cadastre or a legal verdict. Region boundaries must never substitute for parcel/permit boundaries.
- Operator access is allowlisted by TELEGRAM_OPERATOR_IDS; absent configuration means no operator permissions.
- Private-chat ownership checks apply to callbacks, artifacts, boundary uploads, evidence and monitoring.
- AOI half-size choices: 250, 500, 1000 metres; processing grid: 20 metres.
- No satellite-only claim of confirmed excavation, exact event date, volume, ownership or successful reclamation.
- Baseline must be comparable by season; cloud/shadow/snow/nodata masked per AOI; insufficient common valid area prevents a change conclusion.
- One analysis at a time, bounded acquisition attempts, HTTP timeouts, fixed trusted hosts, per-owner limits.
- Monitoring is opt-in after owner-marked local closure, not an official government closure. Persist state, baseline and notification events.

## Shared Contracts

Geometry (`src/land/geometry.js`):

```js
createArea({lat, lon, halfSizeMeters})
// {lat,lon,halfSizeMeters,bbox:[w,s,e,n],epsg,projectedBbox:[x0,y0,x1,y1],width,height,resolution:20}
validateBoundary(geojson, area)
// Polygon/MultiPolygon Feature; bounded vertices, closed valid rings, intersects AOI
analyzePair(before, after, area, boundary = null)
// before/after: {id,datetime,sourceUrl,bands:{red,green,blue,nir,swir16,scl}}
// bands are area.width*area.height arrays of reflectance (SCL class integers).
// returns JSON-compatible {status,method,area,before,after,validFraction,changeHectares,
// candidatePixels:[indices],validPixels:[indices],boundary:{status,outsideHectares},settings}
// statuses: change, no_change, insufficient_data; boundary has geometry, source, verifiedBy if reviewed.
compareBoundary(analysis, boundary)
// recompute boundary fields from the candidate cells, never invent permission.
```

Provider (`src/land/satellite.js`):

```js
createSatelliteProvider({fetchImpl = fetch, now = () => new Date()} = {})
// .getPair(area, {baselineId, afterDate} = {}) -> {before,after} or typed Error
// same-season dates >=45 days apart; baseline fixed for monitoring.
// Common UTM grid. Reflectance honors scale/offset. No whole-scene downloads.
renderScene(scene, area, candidatePixels = []) // PNG Buffer
```

Store/worker (`src/land/store.js`, `src/land/monitor.js`):

```js
createLandStore({file})
// create(owner, {area,language}) -> record; get(id,owner), list(owner)
// update(id,owner, mutator) atomic; listAll() restricted to internal worker/operator layer.
// Record: id,owner,language,area,createdAt,updatedAt,analysis?,boundary?,evidence:[],
// events:[],localStatus:'open',watch:{enabled:false},reportId?,reviewRequested:false.
createMonitor({store, analyze, notify, now, intervalMs})
// .tick() processes due closed watched cases, .start() and .stop().
// analyze(record) returns new analysis; notify(record,event) sends owner notification.
// Persist queued event before notify; mark delivered only on success; bounded retry.
// Additional changes require newer acquisition, same grid/method/baseline, common clear pixels.
```

## Task 1: Geometry and Scientific Limits

Owner: geometry agent. Files: `src/land/geometry.js`, `test/land-geometry.test.js`.

- [ ] Write red tests for aligned UTM AOI, masked clouds, reflectance changes, isolated-pixel rejection, invalid/self-crossing contours, holes and partial boundary overlap.
- [ ] Run `node --test test/land-geometry.test.js`; verify missing behavior.
- [ ] Implement conservative vegetation-to-bare candidate change; annotate as unvalidated heuristic with fixed thresholds. Do not label all unchanged land as safe.
- [ ] Count area from 20m cells; intersect cells with verified GeoJSON using Turf. Unknown/unverified boundaries produce no legal conclusion.
- [ ] Run tests and report exact exports and method limitations.

## Task 2: Real Satellite Data

Owner: satellite agent. Files: `src/land/satellite.js`, `test/land-satellite.test.js`.

- [ ] Write red tests for scene/date/grid selection, trusted asset URLs, bad responses, correct scale/offset, masked/nodata handling and PNG output.
- [ ] Implement Earth Search STAC search and COG range reads with geotiff; no credentials or paid API required for public COG data.
- [ ] Bound query and raster reads, choose same-season baseline, honor cancellation/timeouts, and fail explicitly when usable scenes are absent.
- [ ] Run offline tests. Parent performs a separately identified live-data smoke test and visual inspection.

## Task 3: Durable Cases and Repeat Monitoring

Owner: persistence agent. Files: `src/land/store.js`, `src/land/monitor.js`, their tests.

- [ ] Write red tests for ownership, reopen persistence, concurrent updates and corrupt-file preservation.
- [ ] Implement atomic bounded case storage using current repo patterns. Never overwrite corrupt data.
- [ ] Write red tests for opt-in/closed gating, fixed baseline, newer acquisitions, no repeat alerts, newly clear pixels, notification retry and worker overlap.
- [ ] Implement monitor with injectable analyze/notify. Stop disables further dispatch; failed checks reschedule without claiming no change.
- [ ] Run tests; report crash-retry delivery caveat honestly (Telegram does not provide an idempotency key).

## Task 4: Telegram Integration and Operator Review

Owner: parent. Files: `src/land/service.js`, `src/land/telegram.js`, `src/land/messages.js`, `src/bot.js`, `src/report-cabinet.js`, `src/index.js`, tests.

- [ ] Add failing synthetic Telegram tests for consent, AOI confirmation, late/cancelled replies, private ownership, boundary upload limits, operator authorization, evidence, local closure and watch toggle.
- [ ] Expose analysis beside location, preserve existing photo/report flow, persist landCaseId on reports, and expose cases via /sites and report card.
- [ ] Deliver actual before/after PNGs and source/quality summary, targeted evidence request, editable uploaded contour with source, and explicit operator review decisions.
- [ ] Bound user resources and clean up transient rasters/artifacts; keep analysis metadata and events durable.
- [ ] Start one monitoring worker only in production entrypoint and stop it on shutdown.

## Task 5: Verification and Release

- [ ] Run all offline tests, dependency audit and diff check; independent security/scientific review.
- [ ] Live read-only STAC/COG smoke test on a public Kazakhstan AOI. Verify dated pixels, masks, bounds and PNG rendering. Do not assert change truth without ground validation.
- [ ] Update README and TZKZ with data flow, assumptions, operator setup, limits, and manual Telegram checks.
- [ ] Commit only intended files; preserve user edits. Deploy existing bot service only after tests; preserve its persistent volume and one polling replica.
- [ ] Verify Railway build and startup logs. Report any unconfigured operator or data-access limitation, never call mocked tests real satellite validation.
