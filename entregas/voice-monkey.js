"use strict";

async function announceNewOrder() {
  const token = process.env.VOICE_MONKEY_TOKEN;
  const device = process.env.VOICE_MONKEY_DEVICE;
  if (!token || !device) return;

  const url = new URL("https://api-v3.voicemonkey.io/announce");
  url.search = new URLSearchParams({
    token,
    device,
    speech: "Maikon, chegou um novo chamado da farmacia.",
    language: "pt-BR",
  });
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    redirect: "error",
    cache: "no-store",
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Voice Monkey HTTP ${response.status}`);
}

module.exports = { announceNewOrder };
