# Kazakhstan Regional Boundaries

`kz-regions.geojson` is a derived OpenStreetMap database under ODbL 1.0.
Attribution: OpenStreetMap contributors. Copyright and licence:
https://www.openstreetmap.org/copyright

The file contains the 20 administrative level 4 relations with ISO 3166-2
codes starting with `KZ-`, including Astana, Almaty and Shymkent. Geometry is
converted with `osmtogeojson`, without hand-drawn polygons or simplification.
Its `source` object records the exact query, provider, database timestamp,
retrieval timestamp and SHA-256 of the features. This is an open map dataset,
not an authoritative cadastre or a proof of land ownership or violations.

Rebuild explicitly with `npm run update:boundaries`. The importer requires dev
dependencies and access to a public Overpass instance. `OVERPASS_ENDPOINT` can
select another compatible provider. Failed or incomplete downloads do not
overwrite the existing file. Review boundary/name changes and run tests before
committing the result. Do not schedule repeated bulk downloads on public servers.

At runtime, points are checked locally with Turf.js. No user coordinates are
sent to Overpass, a geocoder or an AI model by the location-processing step.
Map buttons open OpenStreetMap only when the user chooses to follow them.
The optional, separately disclosed AI discussion is an independent data flow.
