import "./memory/db"; // inicializa DB antes que todo
import express from "express";
import { createTelegramBot } from "./bot/telegram.js";
import whatsappRouter from "./bot/whatsapp.route.js";
import { env } from "./config/env.js";

const app = express();

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rutas
app.use("/webhook/whatsapp", whatsappRouter);

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
  app.listen(PORT, () => {
    console.log(`✅ Servidor Express online en puerto ${PORT}`);
  });
}

start().catch((err) => {
  console.error("❌ Error fatal al iniciar:", err);
  process.exit(1);
});
