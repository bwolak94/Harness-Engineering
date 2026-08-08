import type { ToolDefinition } from "@harness/contracts";
import {
  type Candidate,
  type ScreenCandidatesInput,
  ScreenCandidatesInputSchema,
  type ScreenCandidatesOutput,
} from "@harness/contracts/tools";
import type { Tool } from "../application/tool.js";
import type { SubagentTask } from "../ports/supervisor.port.js";
import type { SupervisorPort } from "../ports/supervisor.port.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ScoredCandidate = ScreenCandidatesOutput["scored"][number];

export interface ScreenCandidatesDeps {
  supervisor: SupervisorPort;
  /** Maximum parallel candidate evaluations. Default: 10. */
  concurrencyLimit?: number;
}

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

const LEVEL_SCORES: Record<string, number> = {
  junior: 0.25,
  mid: 0.5,
  senior: 0.75,
  lead: 0.9,
  principal: 1.0,
};

// ---------------------------------------------------------------------------
// scoreCandidate — pure function, context-isolated per candidate
//
// Invariant: scoreCandidate(jobSpec, candidate) is referentially transparent.
// The score is identical regardless of which other candidates are in the batch.
// This is the context isolation proof required by T11 DoD.
// ---------------------------------------------------------------------------

function scoreCandidate(
  jobSpec: ScreenCandidatesInput["jobSpec"],
  candidate: Candidate,
): ScoredCandidate {
  const weights = {
    mustHave: jobSpec.weights?.mustHave ?? 1,
    niceToHave: jobSpec.weights?.niceToHave ?? 0.5,
    seniorityMatch: jobSpec.weights?.seniorityMatch ?? 0.3,
  };

  const candidateSkillsLower = candidate.skills.map((s) => s.toLowerCase());

  // must-have: fraction of required skills present
  const mustHaveMatched = jobSpec.mustHave.filter((req) =>
    candidateSkillsLower.includes(req.toLowerCase()),
  );
  const mustHaveFraction = mustHaveMatched.length / jobSpec.mustHave.length;

  // nice-to-have: fraction matched (full score if no requirements listed)
  const niceToHaveMatched = jobSpec.niceToHave.filter((req) =>
    candidateSkillsLower.includes(req.toLowerCase()),
  );
  const niceToHaveFraction =
    jobSpec.niceToHave.length > 0 ? niceToHaveMatched.length / jobSpec.niceToHave.length : 1.0;

  // seniority: highest level in experience history
  const seniorityFraction =
    candidate.experience.length > 0
      ? Math.max(...candidate.experience.map((e) => LEVEL_SCORES[e.level ?? "junior"] ?? 0.25))
      : 0;

  // Weighted sum normalised to [0, 100]
  const totalWeight = weights.mustHave + weights.niceToHave + weights.seniorityMatch;
  const rawScore =
    mustHaveFraction * weights.mustHave +
    niceToHaveFraction * weights.niceToHave +
    seniorityFraction * weights.seniorityMatch;
  const score = Math.min(100, Math.max(0, (rawScore / totalWeight) * 100));

  const gaps = jobSpec.mustHave.filter((req) => !candidateSkillsLower.includes(req.toLowerCase()));

  return {
    id: candidate.id,
    score: Math.round(score * 100) / 100, // round to 2dp for stable output
    matchedSkills: mustHaveMatched,
    gaps,
    rubricBreakdown: {
      mustHave: Math.round(mustHaveFraction * 100 * 100) / 100,
      niceToHave: Math.round(niceToHaveFraction * 100 * 100) / 100,
      seniority: Math.round(seniorityFraction * 100 * 100) / 100,
    },
  };
}

// ---------------------------------------------------------------------------
// createScreenCandidatesTool
// ---------------------------------------------------------------------------

/**
 * N6 screenCandidates — score and rank a batch of job candidates.
 *
 * Uses the Supervisor to evaluate each candidate in parallel (one SubagentTask
 * per candidate). All scoring is deterministic — no LLM call is made by this
 * tool. Each candidate's score is computed in isolation: the result is identical
 * regardless of batch composition or ordering.
 *
 * Requires: SupervisorPort to be injected (deps.supervisor).
 */
export function createScreenCandidatesTool(
  definition: ToolDefinition,
  deps: ScreenCandidatesDeps,
): Tool<ScreenCandidatesInput, ScreenCandidatesOutput> {
  return {
    definition,
    inputSchema: ScreenCandidatesInputSchema,
    async execute(input: ScreenCandidatesInput): Promise<ScreenCandidatesOutput> {
      // One SubagentTask per candidate — context-isolated by construction.
      const tasks: SubagentTask<ScoredCandidate>[] = input.candidates.map((candidate) => ({
        taskId: candidate.id,
        execute: async (_signal: AbortSignal) => scoreCandidate(input.jobSpec, candidate),
      }));

      const fanOut = await deps.supervisor.fanOut(tasks, {
        concurrencyLimit: deps.concurrencyLimit ?? 10,
      });

      // Collect only successful results; failed candidates are absent from ranking.
      const scored: ScoredCandidate[] = fanOut.results
        .filter((r): r is typeof r & { status: "success" } => r.status === "success")
        .map((r) => r.value)
        .sort((a, b) => b.score - a.score); // descending score

      const successCount = scored.length;
      const totalCount = input.candidates.length;
      const rankingRationale =
        successCount === totalCount
          ? `All ${totalCount} candidates scored. ${fanOut.summary}`
          : `${successCount} of ${totalCount} candidates scored (${totalCount - successCount} failed). ${fanOut.summary}`;

      return { scored, rankingRationale };
    },
  };
}
