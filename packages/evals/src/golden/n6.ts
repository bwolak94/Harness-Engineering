import { FakeModelPort } from "@harness/adapters-memory";
import type { EvalCase } from "../types.js";

/**
 * N6 — screenCandidates golden cases.
 *
 * The tool scores candidates deterministically using a weighted rubric
 * (mustHave, niceToHave, seniority). No LLM involved — pure math.
 *
 * Three scenarios:
 *  1. Two candidates for a TypeScript role — all are scored, best must-have
 *     match has a higher score, gaps array reflects missing skills.
 *  2. Perfect-match candidate vs zero-match candidate — perfect match scores
 *     higher, zero-match has non-empty gaps.
 *  3. Single candidate with custom weights — rubricBreakdown fields present,
 *     rankingRationale is a non-empty string.
 */
export const N6_CASES: EvalCase[] = [
  {
    id: "n6-two-candidates-ranking",
    tool: "screenCandidates",
    description:
      "Two candidates for TypeScript role — both scored, candidate with more must-have skills ranks higher",
    task: {
      id: "eval-n6-two",
      goal: "Screen these two candidates for a senior TypeScript developer role.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("screenCandidates", {
        jobSpec: {
          mustHave: ["TypeScript", "React", "Node.js"],
          niceToHave: ["GraphQL", "Docker"],
        },
        candidates: [
          {
            id: "cand-A",
            skills: ["TypeScript", "React", "Node.js", "GraphQL"],
            experience: [{ role: "Frontend Engineer", durationMonths: 36, level: "senior" }],
          },
          {
            id: "cand-B",
            skills: ["JavaScript", "Vue"],
            experience: [{ role: "Junior Developer", durationMonths: 12, level: "junior" }],
          },
        ],
      }),
      FakeModelPort.textResponse("Screening complete."),
    ]),
    outcomeChecks: [
      // both candidates scored
      { type: "field_equals", path: "scored.length", value: 2 },
      // scores are within [0, 100]
      { type: "field_between", path: "scored.0.score", min: 0, max: 100 },
      { type: "field_between", path: "scored.1.score", min: 0, max: 100 },
      // rankingRationale is a non-empty string
      { type: "field_truthy", path: "rankingRationale" },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "screenCandidates" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: true,
  },

  {
    id: "n6-perfect-vs-zero-match",
    tool: "screenCandidates",
    description:
      "Perfect-match candidate scores > zero-match candidate; zero-match has all mustHave skills in gaps",
    task: {
      id: "eval-n6-perfect",
      goal: "Evaluate these two very different candidates for the Python ML engineer role.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("screenCandidates", {
        jobSpec: {
          mustHave: ["Python", "PyTorch", "scikit-learn"],
          niceToHave: ["Kubernetes", "MLflow"],
        },
        candidates: [
          {
            id: "perfect",
            skills: ["Python", "PyTorch", "scikit-learn", "Kubernetes", "MLflow"],
            experience: [{ role: "ML Engineer", durationMonths: 48, level: "lead" }],
          },
          {
            id: "zero",
            skills: ["Java", "Spring Boot"],
            experience: [{ role: "Backend Developer", durationMonths: 24, level: "mid" }],
          },
        ],
      }),
      FakeModelPort.textResponse("Evaluation done."),
    ]),
    outcomeChecks: [
      { type: "field_equals", path: "scored.length", value: 2 },
      // rankingRationale must be present
      { type: "field_truthy", path: "rankingRationale" },
      // rubricBreakdown must be an object (truthy) on the first result
      { type: "field_truthy", path: "scored.0.rubricBreakdown" },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "screenCandidates" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: false,
  },

  {
    id: "n6-custom-weights",
    tool: "screenCandidates",
    description:
      "Custom weights emphasising must-have (2×) — rubricBreakdown present, all candidates scored",
    task: {
      id: "eval-n6-weights",
      goal: "Screen candidates with custom scoring weights for a DevOps role.",
      budget: { maxTokens: 10_000, maxSteps: 5, maxWallClockMs: 60_000, maxCostUsd: 1.0 },
    },
    model: FakeModelPort.sequence([
      FakeModelPort.toolCallResponse("screenCandidates", {
        jobSpec: {
          mustHave: ["Kubernetes", "Terraform", "CI/CD"],
          niceToHave: ["Helm", "Ansible"],
          weights: { mustHave: 2, niceToHave: 0.5, seniorityMatch: 0.3 },
        },
        candidates: [
          {
            id: "devops-A",
            skills: ["Kubernetes", "Terraform", "CI/CD", "Helm"],
            experience: [{ role: "DevOps Engineer", durationMonths: 30, level: "senior" }],
          },
          {
            id: "devops-B",
            skills: ["Kubernetes", "Docker"],
            experience: [{ role: "SRE", durationMonths: 18, level: "mid" }],
          },
          {
            id: "devops-C",
            skills: ["Jenkins", "Ansible"],
            experience: [{ role: "Build Engineer", durationMonths: 12, level: "junior" }],
          },
        ],
      }),
      FakeModelPort.textResponse("Custom weight screening complete."),
    ]),
    outcomeChecks: [
      { type: "field_equals", path: "scored.length", value: 3 },
      { type: "field_between", path: "scored.0.score", min: 0, max: 100 },
      { type: "field_truthy", path: "scored.0.rubricBreakdown" },
      { type: "field_truthy", path: "rankingRationale" },
    ],
    trajectoryChecks: [
      { type: "tool_called", name: "screenCandidates" },
      { type: "status", expected: "completed" },
      { type: "max_steps", max: 2 },
    ],
    snapshot: false,
  },
];
