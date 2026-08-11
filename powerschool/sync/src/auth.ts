/**
 * Phase 0 step 1. Nothing but "can we get a token and reach the API".
 *
 * Run:  npm run auth
 *
 * This pulls no student data. It fetches a token and reads server metadata.
 * If this fails, every later step fails, so fix it here before going further.
 */

import { loadConfig, redactedConfig, productionRisk } from "./config.ts";
import { PowerSchoolClient } from "./client.ts";

async function main(): Promise<void> {
  const config = loadConfig();

  console.log("Wildcat Hub PowerSchool auth check");
  console.log("Config:", redactedConfig(config));

  const risk = productionRisk(config.host);
  if (risk !== null) {
    console.warn(`\nWARNING: ${risk}\nProceeding only because PS_ALLOW_PRODUCTION is set.\n`);
  }

  const client = new PowerSchoolClient(config);

  const { expiresInSeconds } = await client.authenticate();
  console.log(`\nAuthenticated. Token valid for about ${expiresInSeconds}s.`);

  const metadata = await client.metadata();
  console.log("Server metadata:", JSON.stringify(metadata, null, 2));

  const maxPageSize = Number(metadata?.max_page_size ?? 0);
  if (maxPageSize > 0 && config.pageSize > maxPageSize) {
    console.warn(
      `\nPS_PAGE_SIZE=${config.pageSize} exceeds the server maximum of ${maxPageSize}. ` +
        `Lower it in .env or paging will silently truncate.`,
    );
  }

  console.log("\nRun summary:", client.summary());
  console.log("\nNext: npm run probe");
}

main().catch((error: unknown) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
