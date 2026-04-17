// GSD Extension — ADR-011 Phase 2 Mid-Execution Escalation
//
// A single module that owns: escalation artifact I/O, detection, resolution,
// carry-forward injection lookup, and audit-event emission. Scoped to
// execute-task only (refine-slice escalation is deferred per ADR-011).

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { EscalationArtifact, EscalationOption } from "./types.js";
import { resolveSlicePath } from "./paths.js";
import { atomicWriteSync } from "./atomic-write.js";
import {
  getTask,
  setTaskEscalationPending,
  setTaskEscalationAwaitingReview,
  clearTaskEscalationFlags,
  claimEscalationOverride,
  findUnappliedEscalationOverride,
  setTaskBlockerSource,
  listEscalationArtifacts,
  type TaskRow,
} from "./gsd-db.js";
import { emitUokAuditEvent, buildAuditEnvelope } from "./uok/audit.js";
import { logWarning } from "./workflow-logger.js";

// ─── Paths ────────────────────────────────────────────────────────────────

/**
 * Canonical escalation artifact path, parallel to T##-SUMMARY.md:
 *   .gsd/milestones/{M}/slices/{S}/tasks/{T}-ESCALATION.json
 */
export function escalationArtifactPath(
  basePath: string, milestoneId: string, sliceId: string, taskId: string,
): string | null {
  const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
  if (!sDir) return null;
  return join(sDir, "tasks", `${taskId}-ESCALATION.json`);
}

// ─── Artifact I/O ─────────────────────────────────────────────────────────

/** Build an EscalationArtifact from a gsd_complete_task escalation payload. */
export function buildEscalationArtifact(params: {
  taskId: string;
  sliceId: string;
  milestoneId: string;
  question: string;
  options: EscalationOption[];
  recommendation: string;
  recommendationRationale: string;
  continueWithDefault: boolean;
}): EscalationArtifact {
  return {
    version: 1,
    taskId: params.taskId,
    sliceId: params.sliceId,
    milestoneId: params.milestoneId,
    question: params.question,
    options: params.options,
    recommendation: params.recommendation,
    recommendationRationale: params.recommendationRationale,
    continueWithDefault: params.continueWithDefault,
    createdAt: new Date().toISOString(),
  };
}

/** Atomically write an escalation artifact and flip the appropriate DB flag. */
export function writeEscalationArtifact(
  basePath: string, artifact: EscalationArtifact,
): string {
  const path = escalationArtifactPath(basePath, artifact.milestoneId, artifact.sliceId, artifact.taskId);
  if (!path) {
    throw new Error(
      `escalation: cannot resolve tasks dir for ${artifact.milestoneId}/${artifact.sliceId} — run doctor`,
    );
  }
  mkdirSync(join(path, ".."), { recursive: true });
  atomicWriteSync(path, JSON.stringify(artifact, null, 2));

  if (artifact.continueWithDefault) {
    setTaskEscalationAwaitingReview(artifact.milestoneId, artifact.sliceId, artifact.taskId, path);
  } else {
    setTaskEscalationPending(artifact.milestoneId, artifact.sliceId, artifact.taskId, path);
  }

  emitUokAuditEvent(basePath, buildAuditEnvelope({
    traceId: `escalation:${artifact.milestoneId}:${artifact.sliceId}:${artifact.taskId}`,
    category: "gate",
    type: "escalation-manual-attention-created",
    payload: {
      milestoneId: artifact.milestoneId,
      sliceId: artifact.sliceId,
      taskId: artifact.taskId,
      continueWithDefault: artifact.continueWithDefault,
      optionCount: artifact.options.length,
      recommendation: artifact.recommendation,
    },
  }));

  return path;
}

/** Read an escalation artifact by path. Returns null when missing or malformed. */
export function readEscalationArtifact(path: string): EscalationArtifact | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const art = parsed as EscalationArtifact;
    if (art.version !== 1 || !art.taskId || !art.question) return null;
    return art;
  } catch {
    return null;
  }
}

// ─── Detection ────────────────────────────────────────────────────────────

/**
 * Returns the task id of the first task with an un-resolved pause-escalation
 * (escalation_pending=1, not yet respondedAt). awaiting_review slices are NOT
 * returned — they don't pause the loop.
 */
export function detectPendingEscalation(tasks: TaskRow[], basePath: string): string | null {
  for (const t of tasks) {
    if (t.escalation_pending !== 1) continue;
    if (!t.escalation_artifact_path) continue;
    const art = readEscalationArtifact(t.escalation_artifact_path);
    if (art && !art.respondedAt) return t.id;
  }
  return null;
}

// ─── Resolution ───────────────────────────────────────────────────────────

export interface ResolveEscalationResult {
  status: "resolved" | "not-found" | "already-resolved" | "invalid-choice" | "rejected-to-blocker";
  message: string;
  artifactPath?: string;
  chosenOption?: EscalationOption;
}

/**
 * Apply a user response to a pending escalation:
 *  1) Update the artifact with respondedAt/userChoice/userRationale.
 *  2) Clear the DB escalation flags.
 *  3) For "reject-blocker": set blocker_discovered=1 + blocker_source='reject-escalation'.
 *  4) Emit audit events.
 *
 * Note: this does NOT persist a decision via saveDecisionToDb — the caller
 * (commands/handlers/escalate.ts) owns that step so it can fail gracefully
 * and surface the decision id in the user-visible message.
 */
export function resolveEscalation(
  basePath: string, milestoneId: string, sliceId: string, taskId: string,
  choice: string, rationale: string,
): ResolveEscalationResult {
  const task = getTask(milestoneId, sliceId, taskId);
  if (!task || !task.escalation_artifact_path) {
    return { status: "not-found", message: `No escalation artifact found for ${milestoneId}/${sliceId}/${taskId}.` };
  }
  const art = readEscalationArtifact(task.escalation_artifact_path);
  if (!art) {
    return { status: "not-found", message: `Escalation artifact at ${task.escalation_artifact_path} is missing or malformed.` };
  }
  if (art.respondedAt) {
    return { status: "already-resolved", message: `Escalation for ${taskId} was already resolved at ${art.respondedAt}.` };
  }

  // Resolve `choice` into a concrete option.
  let chosenOption: EscalationOption | undefined;
  if (choice === "accept") {
    chosenOption = art.options.find((o) => o.id === art.recommendation);
  } else if (choice === "reject-blocker") {
    // Handled below; no option selection.
  } else {
    chosenOption = art.options.find((o) => o.id === choice);
    if (!chosenOption) {
      const valid = ["accept", "reject-blocker", ...art.options.map((o) => o.id)].join(", ");
      return { status: "invalid-choice", message: `Unknown choice "${choice}". Valid choices: ${valid}.` };
    }
  }

  const respondedAt = new Date().toISOString();
  const updated: EscalationArtifact = {
    ...art,
    respondedAt,
    userChoice: choice,
    userRationale: rationale,
  };
  atomicWriteSync(task.escalation_artifact_path, JSON.stringify(updated, null, 2));
  clearTaskEscalationFlags(milestoneId, sliceId, taskId);

  if (choice === "reject-blocker") {
    setTaskBlockerSource(milestoneId, sliceId, taskId, "reject-escalation");
    emitUokAuditEvent(basePath, buildAuditEnvelope({
      traceId: `escalation:${milestoneId}:${sliceId}:${taskId}`,
      category: "gate",
      type: "escalation-rejected-to-blocker",
      payload: { milestoneId, sliceId, taskId, rationale },
    }));
    return {
      status: "rejected-to-blocker",
      message: `Escalation rejected. Task ${taskId} now flagged as a blocker — next /gsd auto will replan slice ${sliceId}.`,
      artifactPath: task.escalation_artifact_path,
    };
  }

  emitUokAuditEvent(basePath, buildAuditEnvelope({
    traceId: `escalation:${milestoneId}:${sliceId}:${taskId}`,
    category: "gate",
    type: "escalation-user-responded",
    payload: {
      milestoneId, sliceId, taskId,
      chosenOptionId: chosenOption?.id,
      rationale,
    },
  }));

  return {
    status: "resolved",
    message: `Escalation resolved. Next task in ${sliceId} will receive the override.`,
    artifactPath: task.escalation_artifact_path,
    chosenOption,
  };
}

// ─── Carry-forward lookup ─────────────────────────────────────────────────

/**
 * If this slice has a resolved-but-unapplied escalation override, atomically
 * claim it (via DB UPDATE) and return the markdown block to prepend to the
 * next task's prompt. Returns null when there's no unapplied override OR
 * when another caller claimed it first (idempotent).
 */
export function claimOverrideForInjection(
  basePath: string, milestoneId: string, sliceId: string,
): { injectionBlock: string; sourceTaskId: string } | null {
  const unapplied = findUnappliedEscalationOverride(milestoneId, sliceId);
  if (!unapplied) return null;
  const claimed = claimEscalationOverride(milestoneId, sliceId, unapplied.taskId);
  if (!claimed) return null; // lost the race
  const art = readEscalationArtifact(unapplied.artifactPath);
  // We've already claimed the override in the DB but the file is missing or
  // mid-resolution. Surface a warning so operators can unstick the row if
  // needed — the override is effectively orphaned until a doctor/reset runs.
  if (!art) {
    logWarning(
      "escalation",
      `claim succeeded but artifact missing/malformed at ${unapplied.artifactPath} (task ${unapplied.taskId}); override will not be injected`,
    );
    return null;
  }
  if (!art.respondedAt || !art.userChoice) return null;
  void basePath;
  return {
    injectionBlock: formatOverrideBlock(art),
    sourceTaskId: unapplied.taskId,
  };
}

function formatOverrideBlock(art: EscalationArtifact): string {
  const isReject = art.userChoice === "reject-blocker";
  const choiceLabel = isReject
    ? "rejected — blocker path"
    : art.userChoice === "accept"
      ? `accepted recommendation (${art.recommendation})`
      : (art.options.find((o) => o.id === art.userChoice)?.label ?? art.userChoice ?? "unknown");

  const tradeoffs = art.userChoice && art.userChoice !== "accept" && art.userChoice !== "reject-blocker"
    ? art.options.find((o) => o.id === art.userChoice)?.tradeoffs ?? ""
    : "";

  const rationale = art.userRationale ? `\n\n**User rationale:** ${art.userRationale}` : "";

  return [
    `## Escalation Override (from ${art.taskId})`,
    "",
    `During ${art.taskId} the executor escalated: **${art.question}**`,
    "",
    `The user's resolution: **${choiceLabel}**.${rationale}`,
    tradeoffs ? `\n**Tradeoffs of this choice:** ${tradeoffs}` : "",
    "",
    "Apply this decision as a hard constraint for the current task. If it contradicts the task plan, surface the conflict in your summary rather than silently deviating.",
  ].filter((line) => line !== undefined).join("\n");
}

// ─── Display ──────────────────────────────────────────────────────────────

/** Human-readable summary of an artifact for `/gsd escalate show`. */
export function formatEscalationForDisplay(art: EscalationArtifact): string {
  const resolved = art.respondedAt
    ? `\nResolved: ${art.respondedAt} — user chose "${art.userChoice}"${art.userRationale ? ` (rationale: ${art.userRationale})` : ""}`
    : "\nStatus: awaiting user response";
  const optionLines = art.options.map((o) =>
    `  [${o.id}] ${o.label}${o.id === art.recommendation ? "  (recommended)" : ""}\n      ${o.tradeoffs}`,
  ).join("\n");
  return [
    `Task ${art.taskId} (slice ${art.sliceId})`,
    `continueWithDefault: ${art.continueWithDefault}`,
    `Question: ${art.question}`,
    "",
    "Options:",
    optionLines,
    "",
    `Recommendation: ${art.recommendation} — ${art.recommendationRationale}`,
    resolved,
    "",
    `Resolve with: /gsd escalate resolve ${art.taskId} <${art.options.map((o) => o.id).join("|")}|accept|reject-blocker> [rationale...]`,
  ].join("\n");
}

/** List actionable (unresolved) escalations for `/gsd escalate list`. */
export function listActionableEscalations(milestoneId: string): TaskRow[] {
  return listEscalationArtifacts(milestoneId, /* includeResolved */ false);
}

/** List every escalation (including resolved) for `/gsd escalate list --all`. */
export function listAllEscalations(milestoneId: string): TaskRow[] {
  return listEscalationArtifacts(milestoneId, /* includeResolved */ true);
}
