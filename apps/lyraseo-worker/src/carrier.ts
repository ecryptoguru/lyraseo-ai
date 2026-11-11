import { runtimePaths } from "@lyraseo/contracts/runtime-signing";
import { Bridge, CarrierError, isQueueRef, type Transport } from "./bridge";

export function report(error: unknown) {
  // Fixed codes only. Never serialize input, exception messages or durable IDs.
  console.error(
    JSON.stringify({
      code: error instanceof CarrierError ? error.code : "UNAVAILABLE",
    }),
  );
}
async function sendBounded(queue: Queue, body: unknown, deadline: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const cutoff = Math.min(Date.now() + 5000, deadline);
    const remaining = cutoff - Date.now();
    if (remaining <= 0) throw new CarrierError("DEADLINE");
    await Promise.race([
      queue.send(body, { contentType: "json" }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CarrierError("TRANSPORT")),
          remaining,
        );
      }),
    ]);
    if (Date.now() >= cutoff) throw new CarrierError("TRANSPORT");
  } finally {
    clearTimeout(timer);
  }
}
export async function publish(
  env: Env,
  deadline: number,
  transport?: Transport,
) {
  const bridge = new Bridge(env, transport);
  const claim = await bridge.command(
    runtimePaths[0],
    { limit: 1 },
    deadline,
    true,
  );
  if (claim.disposition !== "OK") throw new CarrierError("UNAVAILABLE");
  for (const ref of claim.refs!) {
    try {
      const sendCutoff = Math.min(Date.now() + 5000, deadline);
      await sendBounded(
        env.WORK_QUEUE,
        { version: 1, workId: ref.workId, generation: ref.generation },
        sendCutoff,
      );
      if (Date.now() >= sendCutoff) throw new CarrierError("TRANSPORT");
    } catch (error) {
      report(error);
      // A timed-out send may have succeeded. Defer only the claimed generation.
      if (Date.now() < deadline)
        await bridge.command(
          runtimePaths[2],
          { ...ref, retrySeconds: 60 },
          deadline,
        );
      throw new CarrierError("UNAVAILABLE");
    }
    const ack = await bridge.command(runtimePaths[1], ref, deadline, true);
    if (ack.disposition !== "DELIVERED" && ack.disposition !== "STALE")
      throw new CarrierError("UNAVAILABLE");
  }
}
export async function scheduledTick(
  controller: ScheduledController,
  env: Env,
  transport?: Transport,
) {
  if (controller.cron !== "* * * * *" && controller.cron !== "*/5 * * * *")
    throw new CarrierError("CONFIGURATION");
  const deadline = Date.now() + 25000;
  // The minute Cron skips coincident five-minute ticks. Their combined branch
  // recovers then dispatches once; overlap across isolates is fenced by A.
  if (
    controller.cron === "* * * * *" &&
    new Date(controller.scheduledTime).getUTCMinutes() % 5 === 0
  )
    return;
  const failures: unknown[] = [];
  if (controller.cron === "*/5 * * * *") {
    try {
      const result = await new Bridge(env, transport).command(
        runtimePaths[4],
        { limit: 20 },
        deadline,
      );
      if (result.disposition !== "OK") throw new CarrierError("UNAVAILABLE");
    } catch (error) {
      report(error);
      failures.push(error);
    }
  }
  try {
    await publish(env, deadline, transport);
  } catch (error) {
    report(error);
    failures.push(error);
  }
  if (failures.length) throw new CarrierError("UNAVAILABLE");
}
export async function consume(
  batch: MessageBatch<unknown>,
  env: Env,
  transport?: Transport,
) {
  // Unexpected batches remain serial and bounded to a single step invocation.
  // Every excess message is explicitly retried, never implicitly acknowledged.
  const deadline = Date.now() + 48000;
  let stepped = false;
  for (const message of batch.messages) {
    if (!isQueueRef(message.body)) {
      console.error(
        JSON.stringify({
          code: "QUEUE_SCHEMA",
          attempts: Math.min(1000000, Math.max(0, message.attempts)),
        }),
      );
      message.retry({ delaySeconds: 60 });
      continue;
    }
    if (stepped || Date.now() >= deadline) {
      message.retry({ delaySeconds: 60 });
      continue;
    }
    stepped = true;
    try {
      const stepCutoff = Math.min(deadline, Date.now() + 47000);
      const result = await new Bridge(env, transport).command(
        runtimePaths[3],
        message.body,
        stepCutoff,
      );
      if (
        Date.now() < stepCutoff &&
        ["COMPLETED", "YIELDED", "STALE"].includes(result.disposition)
      )
        message.ack();
      else message.retry({ delaySeconds: 60 });
    } catch (error) {
      report(error);
      message.retry({ delaySeconds: 60 });
    }
  }
}
