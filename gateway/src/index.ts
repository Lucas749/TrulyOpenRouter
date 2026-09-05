import express from "express";

const PORT = Number(process.env.PORT ?? 4021);

export function createApp() {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ ok: true, service: "tor-gateway" }));
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(PORT, () => console.log(`tor-gateway on :${PORT}`));
}
