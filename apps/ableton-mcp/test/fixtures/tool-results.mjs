export const plannedResult = (extra = {}) => ({ dryRun: true, plan: {},
  confirmation: { token: "test-token", planHash: "0".repeat(64), expiresAt: 60000 }, ...extra });
