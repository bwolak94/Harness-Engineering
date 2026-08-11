import type { HarnessEvent } from "@harness/contracts";
import { useState } from "react";
import { API_BASE, DEV_TOKEN } from "../../../shared/config.js";
import { cn } from "../../../shared/lib/cn.js";

// ---------------------------------------------------------------------------
// Types — derived from approval.requested event payload
// ---------------------------------------------------------------------------

interface PendingApproval {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Derive pending approvals from the event stream.
// An approval is pending when there is no matching approval.granted/rejected.
// ---------------------------------------------------------------------------

function extractPendingApprovals(events: readonly HarnessEvent[]): PendingApproval[] {
  const resolved = new Set<string>();
  const requested: PendingApproval[] = [];

  for (const event of events) {
    if (event.type === "approval.granted" || event.type === "approval.rejected") {
      const payload = event.payload as { requestId: string };
      resolved.add(payload.requestId);
    }
  }

  for (const event of events) {
    if (event.type === "approval.requested") {
      const p = event.payload as {
        requestId: string;
        toolName: string;
        args: Record<string, unknown>;
        reason: string;
        expiresAt: string;
      };
      if (!resolved.has(p.requestId)) {
        requested.push({
          requestId: p.requestId,
          toolName: p.toolName,
          args: p.args,
          reason: p.reason,
          expiresAt: p.expiresAt,
        });
      }
    }
  }

  return requested;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function postDecision(
  workflowId: string,
  path: "approve" | "reject",
  requestId: string,
  comment?: string,
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (DEV_TOKEN) headers.authorization = `Bearer ${DEV_TOKEN}`;
  await fetch(`${API_BASE}/workflows/${workflowId}/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId, decidedBy: "ui-user", comment }),
  });
}

// ---------------------------------------------------------------------------
// ApprovalCard — single pending approval
// ---------------------------------------------------------------------------

function ApprovalCard({
  approval,
  workflowId,
  onSettled,
}: {
  approval: PendingApproval;
  workflowId: string;
  onSettled: () => void;
}) {
  const [loading, setLoading] = useState<"approve" | "reject" | null>(null);
  const [comment, setComment] = useState("");

  async function decide(decision: "approve" | "reject") {
    setLoading(decision);
    try {
      await postDecision(workflowId, decision, approval.requestId, comment || undefined);
      onSettled();
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="rounded-xl border border-ev-warn/40 bg-ev-warn/5 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs text-ev-warn font-semibold uppercase tracking-wide">
            Approval required
          </p>
          <p className="mt-0.5 text-sm font-mono text-white">{approval.toolName}</p>
        </div>
        <span className="shrink-0 text-[10px] font-mono text-[#52525b]">
          exp {new Date(approval.expiresAt).toLocaleTimeString("en-US", { hour12: false })}
        </span>
      </div>

      {/* Reason */}
      <p className="text-xs text-[#a1a1aa] leading-relaxed">{approval.reason}</p>

      {/* Args preview */}
      <pre className="rounded bg-canvas px-3 py-2 text-[11px] font-mono text-[#c4c4d4] overflow-x-auto max-h-32">
        {JSON.stringify(approval.args, null, 2)}
      </pre>

      {/* Comment field */}
      <input
        type="text"
        placeholder="Optional comment…"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        className="w-full rounded bg-canvas border border-border px-3 py-1.5 text-xs text-[#e4e4e7] placeholder:text-[#52525b] focus:outline-none focus:border-accent"
      />

      {/* Actions */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => decide("approve")}
          disabled={loading !== null}
          className={cn(
            "flex-1 rounded-lg py-1.5 text-xs font-semibold transition-colors",
            "bg-ev-success/20 text-ev-success border border-ev-success/30 hover:bg-ev-success/30",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          {loading === "approve" ? "Approving…" : "Approve"}
        </button>
        <button
          type="button"
          onClick={() => decide("reject")}
          disabled={loading !== null}
          className={cn(
            "flex-1 rounded-lg py-1.5 text-xs font-semibold transition-colors",
            "bg-ev-error/20 text-ev-error border border-ev-error/30 hover:bg-ev-error/30",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          {loading === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ApprovalPanel — shown when there are pending approvals
// ---------------------------------------------------------------------------

interface ApprovalPanelProps {
  events: readonly HarnessEvent[];
  workflowId: string | null;
  className?: string;
}

export function ApprovalPanel({ events, workflowId, className }: ApprovalPanelProps) {
  // Local settled set so the panel hides immediately without waiting for WS echo.
  const [localSettled, setLocalSettled] = useState<Set<string>>(new Set());

  if (!workflowId) return null;

  const pending = extractPendingApprovals(events).filter((a) => !localSettled.has(a.requestId));

  if (pending.length === 0) return null;

  return (
    <div
      className={cn(
        "border-t border-ev-warn/30 bg-surface px-4 py-3 space-y-3 shrink-0",
        className,
      )}
    >
      <p className="text-[10px] font-mono text-ev-warn uppercase tracking-widest">
        {pending.length} pending approval{pending.length > 1 ? "s" : ""}
      </p>
      {pending.map((a) => (
        <ApprovalCard
          key={a.requestId}
          approval={a}
          workflowId={workflowId}
          onSettled={() =>
            setLocalSettled((prev) => {
              const next = new Set(prev);
              next.add(a.requestId);
              return next;
            })
          }
        />
      ))}
    </div>
  );
}
