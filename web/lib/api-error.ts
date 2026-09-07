// Normalize API error bodies to a display string. Our Next routes return
// { error: string }; gateway passthroughs relay { error: { message } }.
// CLIENT-SAFE: pure, no imports.

export function apiError(body: unknown, status: number | string): string {
  const d = body as { error?: unknown } | null;
  const e = d?.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(status);
}
