-- KZT and TJS have dedicated Google Sheets cash/inkassa columns and are
-- supported end-to-end again. The enum values already exist.
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_supported_currency";
ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS "OrderItem_supported_currency";
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_supported_currency";
ALTER TABLE "Inkassa" DROP CONSTRAINT IF EXISTS "Inkassa_supported_currency";
ALTER TABLE "CashMovement" DROP CONSTRAINT IF EXISTS "CashMovement_supported_currency";
ALTER TABLE "Debt" DROP CONSTRAINT IF EXISTS "Debt_supported_currency";
