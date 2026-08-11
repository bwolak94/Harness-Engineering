import { z } from "zod";

// ---------------------------------------------------------------------------
// N12 — searchHotels
//
// Finds hotels near a location using OpenStreetMap (Nominatim + Overpass API).
// Returns hotel listings with distances, amenities, and nearby transit stops.
// No API key required — free tier of OSM/Overpass.
// ---------------------------------------------------------------------------

export const SearchHotelsInputSchema = z.object({
  location: z
    .string()
    .min(1)
    .describe("City, address, or landmark to search near. E.g. 'Kraków Old Town, Poland'"),
  radiusKm: z
    .number()
    .positive()
    .max(20)
    .default(2)
    .describe("Search radius in kilometres (default 2, max 20)"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe("Maximum number of hotels to return"),
  checkIn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Check-in date YYYY-MM-DD (informational — Overpass has no live pricing)"),
  checkOut: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Check-out date YYYY-MM-DD (informational)"),
});

export type SearchHotelsInput = z.infer<typeof SearchHotelsInputSchema>;

const TransitStopSchema = z.object({
  name: z.string(),
  type: z.enum(["bus_stop", "tram_stop", "subway", "train", "other"]),
  distanceM: z.number().int().nonnegative(),
});

export const HotelResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  distanceKm: z.number(),
  lat: z.number(),
  lng: z.number(),
  stars: z.number().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  website: z.string().optional(),
  /** OSM amenity tags present on the property (wifi, parking, restaurant, etc.) */
  amenities: z.array(z.string()),
  /** Public transit stops within 500 m, sorted by distance */
  nearbyTransit: z.array(TransitStopSchema),
});

export type HotelResult = z.infer<typeof HotelResultSchema>;

export const SearchHotelsOutputSchema = z.object({
  queryLocation: z.string(),
  resolvedAddress: z.string(),
  centerLat: z.number(),
  centerLng: z.number(),
  radiusKm: z.number(),
  hotels: z.array(HotelResultSchema),
  totalFound: z.number().int(),
  transitStopsInArea: z.number().int(),
  dataSource: z.literal("OpenStreetMap/Nominatim"),
});

export type SearchHotelsOutput = z.infer<typeof SearchHotelsOutputSchema>;
