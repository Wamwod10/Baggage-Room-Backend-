-- KZT/TJS legacy rows remain readable, but new operational writes are blocked.
ALTER TABLE "Order" ADD CONSTRAINT "Order_supported_currency" CHECK ("currency"::text IN ('UZS', 'USD', 'RUB', 'EUR')) NOT VALID;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_supported_currency" CHECK ("currency"::text IN ('UZS', 'USD', 'RUB', 'EUR')) NOT VALID;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_supported_currency" CHECK ("currency"::text IN ('UZS', 'USD', 'RUB', 'EUR')) NOT VALID;
ALTER TABLE "Inkassa" ADD CONSTRAINT "Inkassa_supported_currency" CHECK ("currency"::text IN ('UZS', 'USD', 'RUB', 'EUR')) NOT VALID;
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_supported_currency" CHECK ("currency"::text IN ('UZS', 'USD', 'RUB', 'EUR')) NOT VALID;
ALTER TABLE "Debt" ADD CONSTRAINT "Debt_supported_currency" CHECK ("currency"::text IN ('UZS', 'USD', 'RUB', 'EUR')) NOT VALID;
