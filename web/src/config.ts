// SLA targets shared with frontend (duplicated from server config to avoid bundler complexity)
// Source of truth is server/src/config/constants.ts
export const SLA_TARGETS: Record<string, { firstReplyMinutes: number; resolutionMinutes: number }> = {
  URGENT: { firstReplyMinutes: 120, resolutionMinutes: 540 },
  MEDIUM: { firstReplyMinutes: 270, resolutionMinutes: 1620 },
  LOW:    { firstReplyMinutes: 540, resolutionMinutes: 2700 },
};
