export async function readPullProgress(response: Response, progress: (message: string) => void): Promise<void> {
  if (!response.body) throw new Error("Model service returned no download progress.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", complete = false, previous = "";
  const line = (text: string) => {
    if (!text.trim()) return;
    const data = JSON.parse(text) as { error?: string; status?: string; total?: number; completed?: number };
    if (data.error) throw new Error(`Model download failed: ${data.error}`);
    const percentage = data.total && typeof data.completed === "number" ? Math.min(100, Math.floor(data.completed / data.total * 100)) : null;
    const message = `${data.status ?? "Downloading model"}${percentage === null ? "" : ` · ${percentage}%`}`;
    if (message !== previous) { progress(message); previous = message; }
    if (data.status === "success") complete = true;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const text of lines) line(text);
      if (buffer.length > 65536) throw new Error("Unexpected model download response.");
      if (done) { line(buffer); break; }
    }
    if (!response.ok || !complete) throw new Error("Model download ended before completion. Retry the model change to resume.");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
