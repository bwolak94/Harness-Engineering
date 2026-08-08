import type { ToolDefinition } from "@harness/contracts";
import {
  type SimulatePVPaybackInput,
  SimulatePVPaybackInputSchema,
  type SimulatePVPaybackOutput,
} from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";

/**
 * N8 — simulatePVPayback
 *
 * 8760-step (hourly) solar PV simulation over one calendar year.
 *
 * Irradiance model: simplified Liu-Jordan approach — clearsky global horizontal
 * irradiance is computed from the solar altitude angle derived from latitude,
 * day of year, and hour. No external API — all data is computed locally.
 *
 * This is the computationally heaviest tool in the set (8760 iterations) and
 * is deliberately chosen as the T08 sandbox stress-test. When the model
 * writes code in the sandbox to adjust the consumption profile, it calls
 * runCode and then passes the modified profile to this tool.
 *
 * Key output:
 *   - yearlyKWh            total generation
 *   - selfConsumptionPct   % of generation consumed on-site
 *   - savingsPerYear[]     savings for each projected year (constant generation)
 *   - paybackYears         simple payback
 *   - monthlyBreakdown[]   month-by-month detail (12 entries)
 */
export function createSimulatePVPaybackTool(
  definition: ToolDefinition,
): Tool<SimulatePVPaybackInput, SimulatePVPaybackOutput> {
  return {
    definition,
    inputSchema: SimulatePVPaybackInputSchema,

    async execute(input) {
      const { lat, kWp, tiltDeg, azimuthDeg, consumptionProfile, tariff, capex } = input;

      // DAYS_IN_MONTH[m] where m is 0-based month index
      const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

      // Accumulate per-hour results
      let totalGenerationKwh = 0;
      let totalSelfConsumedKwh = 0;
      let _totalExportedKwh = 0;
      let totalSavingsEur = 0;

      const monthlyGen: number[] = Array(12).fill(0);
      const monthlySelf: number[] = Array(12).fill(0);
      const monthlyExport: number[] = Array(12).fill(0);
      const monthlySavings: number[] = Array(12).fill(0);

      let hour = 0; // absolute hour index 0..8759

      for (let m = 0; m < 12; m++) {
        const daysInMonth = DAYS_IN_MONTH[m] ?? 30;
        for (let d = 0; d < daysInMonth; d++) {
          const dayOfYear = dayOfYearForMonthDay(m, d);

          for (let h = 0; h < 24; h++) {
            const consumption = consumptionProfile[hour] ?? 0;
            const generation = hourlyGenerationKwh(lat, dayOfYear, h, kWp, tiltDeg, azimuthDeg);

            const selfConsumed = Math.min(generation, consumption);
            const exported = Math.max(0, generation - consumption);

            // Calculate savings based on tariff
            const tariffRate = getTariffRate(h, tariff.zones);
            const selfConsumptionSaving = selfConsumed * tariffRate;
            const exportRevenue = tariff.netBilling ? exported * tariff.exportRatePerKwh : 0;

            const hourSaving = selfConsumptionSaving + exportRevenue;

            // Accumulate
            totalGenerationKwh += generation;
            totalSelfConsumedKwh += selfConsumed;
            _totalExportedKwh += exported;
            totalSavingsEur += hourSaving;

            monthlyGen[m] = (monthlyGen[m] ?? 0) + generation;
            monthlySelf[m] = (monthlySelf[m] ?? 0) + selfConsumed;
            monthlyExport[m] = (monthlyExport[m] ?? 0) + exported;
            monthlySavings[m] = (monthlySavings[m] ?? 0) + hourSaving;

            hour++;
          }
        }
      }

      const selfConsumptionPct =
        totalGenerationKwh > 0
          ? Math.round((totalSelfConsumedKwh / totalGenerationKwh) * 10_000) / 100
          : 0;

      const annualSavings = Math.round(totalSavingsEur * 100) / 100;
      const paybackYears =
        annualSavings > 0
          ? Math.round((capex / annualSavings) * 100) / 100
          : Number.POSITIVE_INFINITY;

      // Project savings for payback period (constant generation assumed)
      const projectionYears = Math.min(Math.ceil(paybackYears) + 2, 30);
      const savingsPerYear = Array.from({ length: projectionYears }, () => annualSavings);

      const monthlyBreakdown: SimulatePVPaybackOutput["monthlyBreakdown"] = Array.from(
        { length: 12 },
        (_, m) => ({
          month: m + 1,
          generationKwh: Math.round((monthlyGen[m] ?? 0) * 1000) / 1000,
          selfConsumedKwh: Math.round((monthlySelf[m] ?? 0) * 1000) / 1000,
          exportedKwh: Math.round((monthlyExport[m] ?? 0) * 1000) / 1000,
          savingsEur: Math.round((monthlySavings[m] ?? 0) * 100) / 100,
        }),
      );

      return {
        yearlyKWh: Math.round(totalGenerationKwh * 1000) / 1000,
        selfConsumptionPct,
        savingsPerYear,
        paybackYears,
        monthlyBreakdown,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Solar irradiance model (simplified Liu-Jordan clearsky)
// ---------------------------------------------------------------------------

/** Day of year (1-based) for a given 0-based month and day within month. */
function dayOfYearForMonthDay(month: number, dayInMonth: number): number {
  const DAYS_BEFORE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return (DAYS_BEFORE[month] ?? 0) + dayInMonth + 1;
}

/**
 * Solar declination in radians for a given day of year.
 * Spencer's approximation (±0.3°).
 */
function solarDeclination(dayOfYear: number): number {
  const B = ((2 * Math.PI) / 365) * (dayOfYear - 81);
  return (
    0.006918 -
    0.399912 * Math.cos(B) +
    0.070257 * Math.sin(B) -
    0.006758 * Math.cos(2 * B) +
    0.000907 * Math.sin(2 * B)
  );
}

/**
 * Solar altitude angle (radians) for given lat (°), declination (rad), and
 * solar hour angle (rad, negative in morning, positive in afternoon).
 */
function solarAltitude(latRad: number, decl: number, hourAngle: number): number {
  return Math.asin(
    Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.cos(hourAngle),
  );
}

/**
 * Clear-sky global horizontal irradiance (W/m²) using a simplified Hottel
 * model. Returns 0 for negative altitude (night).
 */
function clearskyGHI(altitudeRad: number): number {
  if (altitudeRad <= 0) return 0;
  const sinAlt = Math.sin(altitudeRad);
  // Direct normal ≈ 1353 W/m² * atmospheric transmittance (simplified)
  const transmittance = 0.7 ** (1 / (sinAlt + 0.001));
  return 1353 * sinAlt * transmittance;
}

/**
 * Irradiance on a tilted plane (W/m²) using the Liu-Jordan isotropic sky model.
 * tiltDeg: 0=horizontal, 90=vertical
 * azimuthDeg: 0=North, 90=East, 180=South, 270=West
 * solarAzimuth is approximated from hour angle.
 */
function irradianceOnTiltedSurface(
  ghi: number,
  altitudeRad: number,
  tiltDeg: number,
  azimuthDeg: number,
  hourAngle: number,
  _latRad: number,
  decl: number,
): number {
  if (ghi <= 0) return 0;

  const tiltRad = (tiltDeg * Math.PI) / 180;

  // Solar azimuth formula gives angle from South (0=South, positive=West).
  // Panel azimuth uses 0=North convention (schema default 180=South).
  // Convert panel azimuth to South-origin frame to align both angles.
  const panelAzFromSouthDeg = (azimuthDeg - 180 + 360) % 360;
  const panelAzRad = (panelAzFromSouthDeg * Math.PI) / 180;

  const sinAlt = Math.sin(altitudeRad);
  const cosAlt = Math.cos(altitudeRad);

  // Solar azimuth from South (positive = West)
  let solarAzRad = 0;
  if (cosAlt > 1e-6) {
    const sinAz = (Math.cos(decl) * Math.sin(hourAngle)) / cosAlt;
    solarAzRad = Math.asin(Math.max(-1, Math.min(1, sinAz)));
  }

  // Angle of incidence on tilted surface (Liu-Jordan)
  const cosI =
    sinAlt * Math.cos(tiltRad) + cosAlt * Math.sin(tiltRad) * Math.cos(solarAzRad - panelAzRad);

  // Direct beam on tilted = Beam * cosI / sinAlt
  // Diffuse (isotropic sky) = 0.3 * GHI * (1 + cos(tilt)) / 2
  // Reflected = 0.2 * GHI * (albedo) * (1 - cos(tilt)) / 2
  const beamFraction = 0.7; // ~typical clearsky fraction
  const diffuse = ghi * (1 - beamFraction);
  const beam = ghi * beamFraction;

  const tiltedBeam = sinAlt > 0.01 ? (beam * Math.max(0, cosI)) / sinAlt : 0;
  const tiltedDiffuse = (diffuse * (1 + Math.cos(tiltRad))) / 2;
  const reflected = (ghi * 0.2 * (1 - Math.cos(tiltRad))) / 2;

  return Math.max(0, tiltedBeam + tiltedDiffuse + reflected);
}

/**
 * Energy generated in one hour (kWh) by a PV system.
 * Performance ratio of 0.75 accounts for inverter, wiring, and temperature losses.
 */
function hourlyGenerationKwh(
  lat: number,
  dayOfYear: number,
  hour: number,
  kWp: number,
  tiltDeg: number,
  azimuthDeg: number,
): number {
  const PERFORMANCE_RATIO = 0.75;
  const PANEL_EFFICIENCY = 1; // kWp already includes panel efficiency

  const latRad = (lat * Math.PI) / 180;
  const decl = solarDeclination(dayOfYear);
  // Solar hour angle: 15° per hour, solar noon = hour 12
  const hourAngle = ((hour - 12) * 15 * Math.PI) / 180;

  const alt = solarAltitude(latRad, decl, hourAngle);
  const ghi = clearskyGHI(alt);

  const irradianceTilted = irradianceOnTiltedSurface(
    ghi,
    alt,
    tiltDeg,
    azimuthDeg,
    hourAngle,
    latRad,
    decl,
  );

  // 1 kWp generates (irradiance / 1000) kWh per hour at STC
  return (irradianceTilted / 1000) * kWp * PERFORMANCE_RATIO * PANEL_EFFICIENCY;
}

// ---------------------------------------------------------------------------
// Tariff helpers
// ---------------------------------------------------------------------------

function getTariffRate(hour: number, zones: SimulatePVPaybackInput["tariff"]["zones"]): number {
  for (const zone of zones) {
    if (hour >= zone.hoursFrom && hour < zone.hoursTo) {
      return zone.pricePerKwh;
    }
  }
  // Fallback: first zone or 0
  return zones[0]?.pricePerKwh ?? 0;
}
