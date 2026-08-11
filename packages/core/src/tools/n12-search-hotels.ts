import type { ToolDefinition } from "@harness/contracts";
import type { HotelResult, SearchHotelsInput, SearchHotelsOutput } from "@harness/contracts/tools";
import { SearchHotelsInputSchema } from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";

// ---------------------------------------------------------------------------
// N12 — searchHotels
//
// Data pipeline:
//   1. Geocode the location string → lat/lng via Nominatim (OSM geocoder).
//   2. Parallel Overpass queries:
//      a. Hotels/hostels/motels/guest_houses within radiusKm.
//      b. Public transit stops (bus, tram, subway, train) within radiusKm.
//   3. For each hotel, compute distance from centre and attach the five
//      nearest transit stops within 500 m (Haversine, in-memory).
//   4. Sort hotels by distance, return up to maxResults.
//
// External services (free, no API key, no auth):
//   - Nominatim:  https://nominatim.openstreetmap.org   (1 req/s courtesy limit)
//   - Overpass:   https://overpass-api.de/api/interpreter
//
// fetch() is available as a global in Node 18+ and is declared in the DOM lib
// added to this package's tsconfig. This does not violate the zero-node-I/O
// invariant (no node:fs, node:net imports) — fetch is a web-standard API.
// ---------------------------------------------------------------------------

const NOMINATIM = "https://nominatim.openstreetmap.org";
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];
const USER_AGENT = "harness-engineering/1.0 (hotel-search-tool)";

// ---------------------------------------------------------------------------
// Haversine distance (km)
// ---------------------------------------------------------------------------

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

// ---------------------------------------------------------------------------
// Nominatim geocoding
// ---------------------------------------------------------------------------

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
}

async function geocode(location: string): Promise<{ lat: number; lng: number; display: string }> {
  const url = `${NOMINATIM}/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const results = (await res.json()) as NominatimResult[];
  const first = results[0];
  if (!first) throw new Error(`Location not found: "${location}"`);
  return {
    lat: Number.parseFloat(first.lat),
    lng: Number.parseFloat(first.lon),
    display: first.display_name,
  };
}

// ---------------------------------------------------------------------------
// Overpass query helpers
// ---------------------------------------------------------------------------

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [3_000, 6_000];

async function overpassQuery(query: string): Promise<OverpassElement[]> {
  const body = `data=${encodeURIComponent(query)}`;
  let lastError: Error | undefined;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
          },
          body,
          signal: AbortSignal.timeout(25_000),
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        break; // network error on this endpoint — try next
      }

      if (RETRYABLE_STATUSES.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
        const delayMs = RETRY_DELAYS_MS[attempt] as number;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      if (RETRYABLE_STATUSES.has(res.status)) {
        lastError = new Error(`Overpass HTTP ${res.status} on ${endpoint}`);
        break; // exhausted retries on this endpoint — try next
      }

      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      const data = (await res.json()) as OverpassResponse;
      return data.elements;
    }
  }

  throw lastError ?? new Error("All Overpass endpoints failed");
}

function elementCoords(el: OverpassElement): { lat: number; lng: number } | null {
  if (el.lat !== undefined && el.lon !== undefined) return { lat: el.lat, lng: el.lon };
  if (el.center) return { lat: el.center.lat, lng: el.center.lon };
  return null;
}

// ---------------------------------------------------------------------------
// Hotel extraction
// ---------------------------------------------------------------------------

const TOURISM_TYPES = new Set(["hotel", "hostel", "motel", "guest_house", "apartment"]);

const AMENITY_TAG_MAP: Array<[string, string]> = [
  ["internet_access", "wifi"],
  ["internet_access:wifi", "wifi"],
  ["wifi", "wifi"],
  ["swimming_pool", "swimming pool"],
  ["fitness_room", "fitness room"],
  ["air_conditioning", "air conditioning"],
  ["breakfast", "breakfast included"],
  ["parking", "parking"],
  ["restaurant", "restaurant on-site"],
  ["bar", "bar on-site"],
];

function extractAmenities(tags: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const [key, label] of AMENITY_TAG_MAP) {
    const v = tags[key];
    if (v && v !== "no") out.add(label);
  }
  return [...out];
}

function buildHotel(el: OverpassElement, centerLat: number, centerLng: number): HotelResult | null {
  const coords = elementCoords(el);
  if (!coords) return null;
  const tags = el.tags ?? {};
  const tourism = tags.tourism ?? "";
  if (!TOURISM_TYPES.has(tourism)) return null;

  const name = tags.name ?? tags["name:en"] ?? tags["name:pl"] ?? `Unnamed ${tourism}`;

  const addressParts = [tags["addr:street"], tags["addr:housenumber"], tags["addr:city"]].filter(
    Boolean,
  );

  const hotel: HotelResult = {
    id: `${el.type}/${el.id}`,
    name,
    type: tourism,
    distanceKm: Math.round(haversineKm(centerLat, centerLng, coords.lat, coords.lng) * 100) / 100,
    lat: coords.lat,
    lng: coords.lng,
    amenities: extractAmenities(tags),
    nearbyTransit: [],
  };

  const starsRaw = tags.stars !== undefined ? Number.parseFloat(tags.stars) : undefined;
  if (starsRaw !== undefined && !Number.isNaN(starsRaw)) hotel.stars = starsRaw;
  if (addressParts.length > 0) hotel.address = addressParts.join(", ");
  if (tags.phone) hotel.phone = tags.phone;
  if (tags.website) hotel.website = tags.website;

  return hotel;
}

// ---------------------------------------------------------------------------
// Transit stop extraction
// ---------------------------------------------------------------------------

type TransitType = "bus_stop" | "tram_stop" | "subway" | "train" | "other";

interface TransitStop {
  name: string;
  type: TransitType;
  lat: number;
  lng: number;
}

function buildTransitStop(el: OverpassElement): TransitStop | null {
  const coords = elementCoords(el);
  if (!coords) return null;
  const tags = el.tags ?? {};
  const name = tags.name ?? tags["name:en"] ?? tags.ref ?? "Stop";

  let type: TransitType = "other";
  if (tags.highway === "bus_stop" || tags.route === "bus") type = "bus_stop";
  else if (tags.railway === "tram_stop") type = "tram_stop";
  else if (tags.railway === "subway_entrance" || tags.station === "subway") type = "subway";
  else if (tags.railway === "halt" || tags.railway === "station") type = "train";

  return { name, type, lat: coords.lat, lng: coords.lng };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createSearchHotelsTool(
  definition: ToolDefinition,
): Tool<SearchHotelsInput, SearchHotelsOutput> {
  return {
    definition,
    inputSchema: SearchHotelsInputSchema,

    async execute(input): Promise<SearchHotelsOutput> {
      // 1. Geocode
      const { lat, lng, display } = await geocode(input.location);
      const radiusM = input.radiusKm * 1000;

      // 2. Build Overpass queries
      const hotelQuery = [
        "[out:json][timeout:25];",
        "(",
        `  node["tourism"~"hotel|hostel|motel|guest_house|apartment"](around:${radiusM},${lat},${lng});`,
        `  way["tourism"~"hotel|hostel|motel|guest_house|apartment"](around:${radiusM},${lat},${lng});`,
        ");",
        `out center ${input.maxResults * 3};`,
      ].join("\n");

      const transitQuery = [
        "[out:json][timeout:25];",
        "(",
        `  node["highway"="bus_stop"](around:${radiusM},${lat},${lng});`,
        `  node["railway"="tram_stop"](around:${radiusM},${lat},${lng});`,
        `  node["railway"="subway_entrance"](around:${radiusM},${lat},${lng});`,
        `  node["station"="subway"](around:${radiusM},${lat},${lng});`,
        `  node["railway"~"halt|station"](around:${radiusM},${lat},${lng});`,
        ");",
        "out 100;",
      ].join("\n");

      // 3. Run sequentially — Overpass enforces per-IP concurrency limits;
      //    two simultaneous POSTs from the same host reliably trigger 429.
      const hotelEls = await overpassQuery(hotelQuery);
      const transitEls = await overpassQuery(transitQuery);

      // 4. Parse transit stops
      const transitStops: TransitStop[] = transitEls
        .map(buildTransitStop)
        .filter((t): t is TransitStop => t !== null);

      // 5. Parse hotels, attach nearest transit, sort by distance
      const TRANSIT_RADIUS_M = 500;

      const hotels: HotelResult[] = hotelEls
        .map((el) => buildHotel(el, lat, lng))
        .filter((h): h is HotelResult => h !== null)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, input.maxResults)
        .map((hotel) => {
          const near = transitStops
            .map((t) => ({
              name: t.name,
              type: t.type,
              distanceM: Math.round(haversineKm(hotel.lat, hotel.lng, t.lat, t.lng) * 1000),
            }))
            .filter((t) => t.distanceM <= TRANSIT_RADIUS_M)
            .sort((a, b) => a.distanceM - b.distanceM)
            .slice(0, 5);
          return { ...hotel, nearbyTransit: near };
        });

      return {
        queryLocation: input.location,
        resolvedAddress: display,
        centerLat: lat,
        centerLng: lng,
        radiusKm: input.radiusKm,
        hotels,
        totalFound: hotels.length,
        transitStopsInArea: transitStops.length,
        dataSource: "OpenStreetMap/Nominatim",
      };
    },
  };
}
