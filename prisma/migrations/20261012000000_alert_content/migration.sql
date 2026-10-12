-- Alerts store a code + JSON params and are rendered per language at send/print time (#49).
-- Existing English texts become `text` alerts (shown as they are).
ALTER TABLE "Alert" ADD COLUMN "code" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "Alert" ADD COLUMN "params" TEXT NOT NULL DEFAULT '{}';
UPDATE "Alert" SET "params" = json_object('text', "message");
ALTER TABLE "Alert" DROP COLUMN "message";
