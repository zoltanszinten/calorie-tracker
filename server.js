"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const folder = __dirname;
const pageFile = path.join(folder, "index.html");
const dataFile = path.join(folder, "calorie-data.json");
const backupFile = path.join(folder, "calorie-data.backup.json");
const port = Number(process.env.CALORIE_PORT || 8766);
const origin = `http://127.0.0.1:${port}`;
const maxMultiplier = Math.floor(Number.MAX_SAFE_INTEGER / 100000);

function validDay(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [year, month, date] = day.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, date));
  return check.getUTCFullYear() === year && check.getUTCMonth() + 1 === month && check.getUTCDate() === date;
}

function validEntry(entry) {
  return entry && typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 100 &&
    validDay(entry.day) && Number.isInteger(entry.kcal) && entry.kcal >= 1 && entry.kcal <= 100000 &&
    typeof entry.multiplier === "number" && Number.isFinite(entry.multiplier) && entry.multiplier > 0 && entry.multiplier <= maxMultiplier &&
    (entry.operation === "add" || entry.operation === "subtract") &&
    Number.isSafeInteger(entry.created) && entry.created > 0;
}

function readEntries() {
  if (!fs.existsSync(dataFile)) return [];
  const entries = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  if (!Array.isArray(entries) || !entries.every(validEntry)) throw new Error("Saved calorie data is invalid. Check the backup before changing it.");
  return entries;
}

function writeEntries(entries) {
  const temporary = path.join(folder, `.calorie-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(entries, null, 2) + "\n", "utf8");
    if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, backupFile);
    fs.renameSync(temporary, dataFile);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function send(response, status, value, contentType = "application/json; charset=utf-8") {
  response.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(contentType.startsWith("application/json") ? JSON.stringify(value) : value);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== "GET" && request.headers.origin && request.headers.origin !== origin) {
      send(response, 403, { error: "This request must come from Calorie Tracker." });
      return;
    }
    const url = new URL(request.url, origin);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      send(response, 200, fs.readFileSync(pageFile), "text/html; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/ui.css") {
      send(response, 200, fs.readFileSync(path.join(folder, "ui.css")), "text/css; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/entries") {
      send(response, 200, { entries: readEntries() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/entries") {
      const body = await readBody(request);
      const entry = { day: body?.day, kcal: body?.kcal, multiplier: body?.multiplier, operation: body?.operation };
      if (!validEntry({ ...entry, id: "new", created: Date.now() })) {
        send(response, 400, { error: "Enter 1–100,000 whole kcal, a positive multiplier, and a valid date." });
        return;
      }
      const entries = readEntries();
      entries.push({ ...entry, id: crypto.randomUUID(), created: Date.now() });
      writeEntries(entries);
      send(response, 201, { entries });
      return;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/entries/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/entries/".length));
      const entries = readEntries();
      const next = entries.filter(entry => entry.id !== id);
      if (next.length === entries.length) { send(response, 404, { error: "Entry not found." }); return; }
      writeEntries(next);
      send(response, 200, { entries: next });
      return;
    }
    send(response, 404, { error: "Not found." });
  } catch (error) {
    const badRequest = error instanceof SyntaxError || error.message === "Request is too large.";
    console.error(error);
    send(response, badRequest ? 400 : 500, { error: badRequest ? "Invalid request." : "Could not read or save calorie data." });
  }
});

server.listen(port, "127.0.0.1", () => {
  if (!fs.existsSync(dataFile)) writeEntries([]);
  console.log(`Calorie Tracker is running at ${origin}/`);
  console.log(`Entries are saved in ${dataFile}`);
});

server.on("error", error => {
  console.error(`Could not start Calorie Tracker: ${error.message}`);
  process.exitCode = 1;
});
