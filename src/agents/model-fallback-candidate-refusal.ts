import { collectErrorGraphCandidates } from "../infra/errors.js";

/**
 * A candidate cannot run on this turn's recorded account. It proves nothing about the
 * models already tried, so fallback skips it instead of reporting it over their failure.
 */
export class ModelFallbackCandidateRefusal extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelFallbackCandidateRefusal";
  }
}

/** Skips only after an earlier outcome exists; a refusal with no prior outcome is the report. */
export function shouldSkipRefusedFallbackCandidate(params: {
  error: unknown;
  lastError: unknown;
  attemptCount: number;
}): boolean {
  return (
    (params.lastError !== undefined || params.attemptCount > 0) &&
    collectErrorGraphCandidates(params.error, (candidate) => [candidate.cause]).some(
      (candidate) => candidate instanceof ModelFallbackCandidateRefusal,
    )
  );
}
