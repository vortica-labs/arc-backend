import "dotenv/config";
import { loadSecretsManagerEnv } from "./config/secrets";

const launch = async (): Promise<void> => {
  // This entrypoint intentionally performs no import of env/app/database
  // modules until Secrets Manager has hydrated process.env.
  await loadSecretsManagerEnv();
  await import("./server");
};

launch().catch((error) => {
  console.error(`Fatal launcher failure: ${String(error)}`);
  process.exit(1);
});
