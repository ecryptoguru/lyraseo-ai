-- Existing pending challenges lack session evidence and must be reissued.
ALTER TABLE "SiteVerificationChallenge" ADD COLUMN "sessionId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "SiteVerificationChallenge" ALTER COLUMN "sessionId" DROP DEFAULT;
UPDATE "SiteVerificationChallenge" SET "revokedAt"=CURRENT_TIMESTAMP WHERE "consumedAt" IS NULL AND "revokedAt" IS NULL;
