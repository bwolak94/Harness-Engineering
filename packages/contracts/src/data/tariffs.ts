/**
 * Simplified HS tariff data for N3 (calculateLandedCost).
 * Keyed by HS chapter (first 2 digits). Each entry lists duty rate % and VAT % by
 * destination country. Preferential rates apply when preferentialOrigin=true.
 *
 * NOTE: These are illustrative rates for educational purposes.
 * Always verify against the official tariff schedule before use in production.
 */

export interface TariffEntry {
  hsChapter: string;
  description: string;
  dutyRatePct: number;
  preferentialRatePct: number;
  vatByCountry: Record<string, number>;
  excisePct: number;
}

export const HS_TARIFF_TABLE: readonly TariffEntry[] = [
  {
    hsChapter: "01",
    description: "Live animals",
    dutyRatePct: 0,
    preferentialRatePct: 0,
    vatByCountry: { PL: 8, DE: 7, FR: 5.5, US: 0, GB: 0 },
    excisePct: 0,
  },
  {
    hsChapter: "02",
    description: "Meat and edible meat offal",
    dutyRatePct: 12.8,
    preferentialRatePct: 0,
    vatByCountry: { PL: 5, DE: 7, FR: 5.5, US: 0, GB: 0 },
    excisePct: 0,
  },
  {
    hsChapter: "08",
    description: "Edible fruit and nuts",
    dutyRatePct: 8.8,
    preferentialRatePct: 0,
    vatByCountry: { PL: 5, DE: 7, FR: 5.5, US: 0, GB: 0 },
    excisePct: 0,
  },
  {
    hsChapter: "22",
    description: "Beverages, spirits and vinegar",
    dutyRatePct: 9.6,
    preferentialRatePct: 3.2,
    vatByCountry: { PL: 23, DE: 19, FR: 20, US: 0, GB: 20 },
    excisePct: 4.0,
  },
  {
    hsChapter: "24",
    description: "Tobacco and manufactured tobacco substitutes",
    dutyRatePct: 57.6,
    preferentialRatePct: 57.6,
    vatByCountry: { PL: 23, DE: 19, FR: 20, US: 0, GB: 20 },
    excisePct: 8.0,
  },
  {
    hsChapter: "61",
    description: "Articles of apparel, knitted or crocheted",
    dutyRatePct: 12,
    preferentialRatePct: 0,
    vatByCountry: { PL: 23, DE: 19, FR: 20, US: 0, GB: 20 },
    excisePct: 0,
  },
  {
    hsChapter: "62",
    description: "Articles of apparel, not knitted or crocheted",
    dutyRatePct: 12,
    preferentialRatePct: 0,
    vatByCountry: { PL: 23, DE: 19, FR: 20, US: 0, GB: 20 },
    excisePct: 0,
  },
  {
    hsChapter: "84",
    description: "Nuclear reactors, boilers, machinery",
    dutyRatePct: 2.7,
    preferentialRatePct: 0,
    vatByCountry: { PL: 23, DE: 19, FR: 20, US: 0, GB: 20 },
    excisePct: 0,
  },
  {
    hsChapter: "85",
    description: "Electrical machinery and equipment",
    dutyRatePct: 2.5,
    preferentialRatePct: 0,
    vatByCountry: { PL: 23, DE: 19, FR: 20, US: 0, GB: 20 },
    excisePct: 0,
  },
  {
    hsChapter: "87",
    description: "Vehicles other than railway rolling stock",
    dutyRatePct: 6.5,
    preferentialRatePct: 0,
    vatByCountry: { PL: 23, DE: 19, FR: 20, US: 2.5, GB: 20 },
    excisePct: 0,
  },
  {
    hsChapter: "90",
    description: "Optical, photographic, measuring instruments",
    dutyRatePct: 2.0,
    preferentialRatePct: 0,
    vatByCountry: { PL: 23, DE: 19, FR: 20, US: 0, GB: 20 },
    excisePct: 0,
  },
];

/** Look up tariff entry by HS code (uses first 2 digits as chapter). */
export function lookupTariff(hsCode: string): TariffEntry | undefined {
  const chapter = hsCode.slice(0, 2);
  return HS_TARIFF_TABLE.find((e) => e.hsChapter === chapter);
}
