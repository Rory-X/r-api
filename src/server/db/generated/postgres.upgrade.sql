ALTER TABLE "model_availability" ADD COLUMN "context_length" INTEGER;
ALTER TABLE "model_availability" ADD COLUMN "context_source" TEXT;
ALTER TABLE "model_availability" ADD COLUMN "context_updated_at" TEXT;
ALTER TABLE "token_model_availability" ADD COLUMN "context_length" INTEGER;
ALTER TABLE "token_model_availability" ADD COLUMN "context_source" TEXT;
ALTER TABLE "token_model_availability" ADD COLUMN "context_updated_at" TEXT;
