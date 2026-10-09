-- Additive only. Run through the normal reviewed migration rollout.
-- Existing updatedAt values begin at rollout: prior last-edit times are unknown.
ALTER TABLE "Shift" ADD COLUMN "createdAt" TIMESTAMP(3);
UPDATE "Shift" SET "createdAt" = "openedAt";
ALTER TABLE "Shift" ALTER COLUMN "createdAt" SET NOT NULL;
ALTER TABLE "Shift" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Shift" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Expense" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Inkassa" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "CashMovement" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE FUNCTION jarvis_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := GREATEST(timezone('UTC', clock_timestamp()), OLD."updatedAt" + interval '1 millisecond');
  RETURN NEW;
END;
$$;

CREATE TRIGGER jarvis_shift_updated_at BEFORE UPDATE ON "Shift"
  FOR EACH ROW EXECUTE FUNCTION jarvis_touch_updated_at();
CREATE TRIGGER jarvis_expense_updated_at BEFORE UPDATE ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION jarvis_touch_updated_at();
CREATE TRIGGER jarvis_inkassa_updated_at BEFORE UPDATE ON "Inkassa"
  FOR EACH ROW EXECUTE FUNCTION jarvis_touch_updated_at();
CREATE TRIGGER jarvis_movement_updated_at BEFORE UPDATE ON "CashMovement"
  FOR EACH ROW EXECUTE FUNCTION jarvis_touch_updated_at();
