import { getStore } from "@netlify/blobs";
import { runWakeUp } from "./_shared/caspian-wakeup-core.mts";

export default async (): Promise<void> => {
  if ((process.env.CASPIAN_WAKE_ENABLED ?? "true").trim().toLowerCase() === "false") {
    console.log(JSON.stringify({ feature: "caspian-wakeup", ok: true, woke: false, skipped: "disabled" }));
    return;
  }
  const result = await runWakeUp("scheduled", {
    wakeStore: getStore({ name: "caspian-wakeup", consistency: "strong" }),
    guardStore: getStore({ name: "sleep-guard-events", consistency: "strong" }),
    callModel: fetch,
    sendBark: fetch,
    random: Math.random,
    now: () => new Date(),
  });
  console.log(JSON.stringify({ feature: "caspian-wakeup", ...result }));
};

export const config = {
  schedule: "*/10 * * * *",
};
