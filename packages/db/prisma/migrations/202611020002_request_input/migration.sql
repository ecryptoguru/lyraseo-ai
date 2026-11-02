-- Legacy operations have no recoverable payload. Legacy unconsumed quotes are
-- invalidated by their input fingerprint when the original request was non-null.
ALTER TABLE "Operation" ADD COLUMN "requestInput" JSONB;
ALTER TABLE "OperationQuote" ADD COLUMN "requestInput" JSONB NOT NULL DEFAULT 'null'::jsonb;
ALTER TABLE "OperationQuote" ALTER COLUMN "requestInput" DROP DEFAULT;
-- Prevent admission of every previously issued unconsumed quote, even a null-input quote.
UPDATE "OperationQuote" SET "inputHash"='legacy-payload-unavailable' WHERE "consumedOperationId" IS NULL;
