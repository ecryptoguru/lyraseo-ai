import { z } from "zod";
import { database, resolveActor } from "@/server/auth/server";
import {
  assignAuditIssue,
  listAuditAssignments,
  readAuditAssignment,
} from "@lyraseo/db/issue-assignments";
import {
  privateBody,
  privateHeaders,
  scopeSchema,
  editorialFailure,
} from "@/server/editorial/http";
const id = z.string().min(1).max(128);
export async function GET(request: Request) {
  try {
    const input = scopeSchema
      .extend({
        auditId: id,
        ruleId: id.optional(),
        scopeKey: z.string().min(1).max(2048).optional(),
      })
      .strict()
      .refine(
        (input) =>
          (input.ruleId === undefined) === (input.scopeKey === undefined),
      )
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(
      input.ruleId !== undefined && input.scopeKey !== undefined
        ? await readAuditAssignment(
            database(),
            await resolveActor(),
            scopeSchema.parse(input),
            {
              auditId: input.auditId,
              ruleId: input.ruleId,
              scopeKey: input.scopeKey,
            },
          )
        : await listAuditAssignments(
            database(),
            await resolveActor(),
            scopeSchema.parse(input),
            input.auditId,
          ),
      { headers: privateHeaders },
    );
  } catch (error) {
    return editorialFailure(error);
  }
}
export async function POST(request: Request) {
  try {
    const actor = await resolveActor(),
      input = scopeSchema
        .extend({
          auditId: id,
          ruleId: id,
          scopeKey: z.string().min(1).max(2048),
          assigneeUserId: id.nullable(),
          expectedRevision: z.number().int().nonnegative(),
          idempotencyKey: id,
        })
        .strict()
        .parse(await privateBody(request));
    return Response.json(
      await assignAuditIssue(database(), actor, scopeSchema.parse(input), {
        auditId: input.auditId,
        ruleId: input.ruleId,
        scopeKey: input.scopeKey,
        assigneeUserId: input.assigneeUserId,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
      }),
      { headers: privateHeaders },
    );
  } catch (error) {
    return editorialFailure(error);
  }
}
