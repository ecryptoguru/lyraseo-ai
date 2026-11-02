import { consume, scheduledTick } from "./carrier";

export default {
  fetch(): Response {
    return new Response("Provider work is unavailable until configured.", {
      status: 503,
    });
  },
  async queue(batch, env) {
    await consume(batch, env);
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(scheduledTick(controller, env));
  },
} satisfies ExportedHandler<Env, unknown>;
