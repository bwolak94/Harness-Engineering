import { z } from "zod";

/**
 * IMPORTANT — protected characteristics are deliberately excluded from the schema.
 * Age, gender, nationality, health status, and any other protected attribute must
 * never appear in candidate input. This is a conscious architectural decision (see
 * ADR 0002) to prevent the scoring algorithm from serving as a discrimination engine.
 * Documented here so future contributors cannot claim it was an oversight.
 */
export const CandidateSchema = z.object({
  id: z.string().min(1).describe("Anonymised candidate identifier"),
  skills: z.array(z.string()).min(1),
  experience: z.array(
    z.object({
      role: z.string().min(1),
      durationMonths: z.number().int().nonnegative(),
      level: z.enum(["junior", "mid", "senior", "lead", "principal"]).optional(),
    }),
  ),
  certifications: z.array(z.string()).optional(),
});

export const ScreenCandidatesInputSchema = z.object({
  jobSpec: z.object({
    mustHave: z.array(z.string()).min(1),
    niceToHave: z.array(z.string()).default([]),
    weights: z
      .object({
        mustHave: z.number().positive().default(1),
        niceToHave: z.number().positive().default(0.5),
        seniorityMatch: z.number().positive().default(0.3),
      })
      .optional(),
  }),
  candidates: z.array(CandidateSchema).min(1),
});

export const ScreenCandidatesOutputSchema = z.object({
  scored: z.array(
    z.object({
      id: z.string(),
      score: z.number().min(0).max(100),
      matchedSkills: z.array(z.string()),
      gaps: z.array(z.string()).describe("Required skills not evidenced"),
      rubricBreakdown: z.record(z.string(), z.number()).describe("Score per rubric dimension"),
    }),
  ),
  rankingRationale: z.string().describe("Explanation of how ranking weights were applied"),
});

export type Candidate = z.infer<typeof CandidateSchema>;
export type ScreenCandidatesInput = z.infer<typeof ScreenCandidatesInputSchema>;
export type ScreenCandidatesOutput = z.infer<typeof ScreenCandidatesOutputSchema>;
