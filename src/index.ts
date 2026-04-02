import "dotenv/config";
import "./memory/db"; // inicializa DB antes que todo
// @ts-ignore
import express from "express";
import { createTelegramBot } from "./bot/telegram.js";
import whatsappRouter from "./bot/whatsapp.route.js";
import landingsRouter from "./routes/landings.route.js";

const app = (express as any)();

// Middlewares
app.use((express as any).json());
app.use((express as any).urlencoded({ extended: true }));

// Rutas
app.use("/webhook/whatsapp", whatsappRouter);
app.use("/l", landingsRouter);         // sirve /l/:slug
app.use("/", landingsRouter);          // sirve /api/landings y /api/landing-generate

// Start Server
const PORT = process.env.PORT || 8080;

async function start() {
  console.log("🤖 Iniciando JARVIS v2...");

  // Iniciar bot de Telegram
  try {
    const telegramBot = createTelegramBot();
    
    // grammy recomienda llamar a .start de forma asíncrona pero sin await si queremos
    // que el código continúe, o ejecutar expr y telegram al mismo tiempo
    telegramBot.start({
      onStart: (info) => {
        console.log(`✅ Telegram Bot online → @${info.username}`);
      },
    }).catch(err => {
      console.error("❌ Error en Telegram Bot:", err);
    });
  } catch (err) {
    console.error("❌ Error al inicializar Telegram Bot:", err);
  }

  // Iniciar servidor Express (Webhook WA)
  app.listen(Number(PORT), () => {
    console.log(`✅ Servidor Express online en puerto ${PORT}`);
  });
}

start().catch((err) => {
  console.error("❌ Error fatal al iniciar:", err);
  process.exit(1);
});
