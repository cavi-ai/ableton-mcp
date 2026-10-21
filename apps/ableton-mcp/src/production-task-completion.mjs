// Task summaries and model-selected checks cannot establish that a requested
// change is unnecessary. Only fresh caller-owned criteria can establish a no-op.
export async function assessTaskCompletion({ intent, functional, postconditions, verify }) {
  if (!functional) return { status: "proposed" };
  if (intent === "inspect") return { status: "observed" };
  if (functional.operations.length) return { status: "proposed" };
  if (!postconditions?.length) return { status: "incomplete", stopReason: "missing_operations" };
  try {
    const checks = await verify(postconditions);
    return checks.length === postconditions.length && checks.every(check => check.matches)
      ? { status: "no_change_needed", checks }
      : { status: "incomplete", stopReason: "postconditions_unmet", checks };
  } catch (error) {
    return { status: "incomplete", stopReason: "postconditions_unavailable", error: error.message };
  }
}
