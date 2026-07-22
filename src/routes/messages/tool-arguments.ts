export const parseFunctionCallArguments = (
  rawArguments: string,
): Record<string, unknown> => {
  if (typeof rawArguments !== "string" || rawArguments.trim().length === 0) {
    return {}
  }

  try {
    const parsed: unknown = JSON.parse(rawArguments)

    if (Array.isArray(parsed)) {
      return { arguments: parsed }
    }

    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>
    }
  } catch {
    return { raw_arguments: rawArguments }
  }

  return { raw_arguments: rawArguments }
}
