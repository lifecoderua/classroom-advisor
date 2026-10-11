-- AlterTable
ALTER TABLE "CheckResult" ADD COLUMN "throughCommentId" INTEGER;

-- Existing LLM results saw the comments stored before they ran.
UPDATE "CheckResult" SET "throughCommentId" = (
    SELECT MAX(c."id") FROM "Comment" c
    JOIN "Submission" s ON s."assignmentId" = c."assignmentId"
    JOIN "SubmissionVersion" v ON v."submissionId" = s."id"
    WHERE v."id" = "CheckResult"."submissionVersionId" AND c."firstSeenAt" <= "CheckResult"."createdAt"
) WHERE "source" LIKE 'llm:%';
