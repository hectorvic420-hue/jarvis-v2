// src/routes/landings.route.ts
import { Router, Request, Response } from "express";
import fs   from "fs";
import path from "path";
import db   from "../memory/db.js";
import { landingBuilderTool } from "../tools/landing_builder.js";

const LANDINGS_DIR = process.env.LANDINGS_DIR || path.join(process.cwd(), "landings");
const router       = Router();

// ─── GET /api/landings — Listar landings ─────────────────────────────────────
router.get("/api/landings", (_req: Request, res: Response) => {
  const PUBLIC_URL = (process.env.PUBLIC_URL || "http://localhost:8080").replace(/\/$/, "");
  const rows = db.prepare(
    `SELECT slug, title, style, checkout_url, created_at, views FROM landings ORDER BY created_at DESC`
  ).all() as any[];

  const result = rows.map(r => ({
    ...r,
    url: `${PUBLIC_URL}/l/${r.slug}`,
  }));

  res.json(result);
});

// ─── DELETE /api/landings/:slug ───────────────────────────────────────────────
router.delete("/api/landings/:slug", (req: Request, res: Response) => {
  const { slug } = req.params;
  const row = db.prepare(`SELECT html_path FROM landings WHERE slug = ?`).get(slug) as any;
  if (!row) { res.status(404).json({ error: "not found" }); return; }

  try { fs.unlinkSync(row.html_path); } catch { /* ok */ }
  db.prepare(`DELETE FROM landings WHERE slug = ?`).run(slug);
  res.json({ ok: true });
});

// ─── GET /api/landings/:slug — Detalle ───────────────────────────────────────
router.get("/api/landings/:slug", (req: Request, res: Response) => {
  const PUBLIC_URL = (process.env.PUBLIC_URL || "http://localhost:8080").replace(/\/$/, "");
  const row = db.prepare(`SELECT slug, title, style, checkout_url, pixel_id, ga_id, created_at, views FROM landings WHERE slug = ?`).get(req.params.slug) as any;
  if (!row) { res.status(404).json({ error: "not found" }); return; }
  res.json({ ...row, url: `${PUBLIC_URL}/l/${row.slug}` });
});

// ─── GET /wizard — Formulario web ────────────────────────────────────────────
router.get("/wizard", (_req: Request, res: Response) => {
  const wizardPath = path.join(process.cwd(), "src", "public", "wizard", "index.html");
  res.sendFile(wizardPath);
});

// ─── POST /api/landing-generate — Generar desde wizard web ───────────────────
router.post("/api/landing-generate", async (req: Request, res: Response) => {
  try {
    const result = await landingBuilderTool.execute(req.body as Record<string, unknown>, "web");
    const urlMatch = result.match(/https?:\/\/[^\s\n]+/);
    const url = urlMatch ? urlMatch[0] : null;
    if (url) {
      res.json({ url });
    } else {
      res.status(500).json({ error: result });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /:slug — Servir landing (catch-all, MUST be last) ───────────────────
router.get("/:slug", (req: Request, res: Response) => {
  const { slug } = req.params;
  const row = db.prepare(`SELECT html_path FROM landings WHERE slug = ?`).get(slug) as any;

  if (!row) {
    res.status(404).send("<h1>Landing no encontrada</h1>");
    return;
  }

  if (!fs.existsSync(row.html_path)) {
    res.status(404).send("<h1>Archivo no encontrado</h1>");
    return;
  }

  // Incrementar visitas
  db.prepare(`UPDATE landings SET views = views + 1 WHERE slug = ?`).run(slug);

  const html = fs.readFileSync(row.html_path, "utf-8");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

export default router;
