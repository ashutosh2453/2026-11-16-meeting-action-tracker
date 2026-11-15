import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { Store } from "./db.js";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? "data/meetings.db";
const staticDir = process.env.STATIC_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));

const store = new Store(dbPath);
const server = createApp(store, { staticDir }).listen(port, () => {
  console.log(`meeting-action-tracker listening on http://localhost:${port} (db: ${dbPath})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
