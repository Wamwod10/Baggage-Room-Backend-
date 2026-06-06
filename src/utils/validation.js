const { z } = require("zod");

const idParam = z.object({ params: z.object({ id: z.string().min(1) }) });
const branchParam = z.object({ params: z.object({ branchId: z.string().min(1) }) });

const currency = z.enum(["UZS", "USD", "RUB", "EUR"]);
const paymentType = z.enum(["CASH", "CARD", "TRANSFER", "DEBT"]);
const lockerStatus = z.enum(["EMPTY", "BUSY", "DELAYED", "SERVICE"]);
const lockerSize = z.enum(["S", "M", "L"]);
const orderStatus = z.enum(["ACTIVE", "PICKED_UP", "CANCELLED", "DELAYED"]);

const optionalInt = z.coerce.number().int().optional();
const amount = z.coerce.number().int().min(0);
const phone = z.string().trim().min(5).max(32).regex(/^[+0-9()\-\s]+$/, "Invalid phone number");

const listQuery = z.object({
  query: z.object({
    branchId: z.string().optional(),
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    status: z.string().optional(),
    paymentType: z.string().optional(),
    currency: z.string().optional(),
    search: z.string().optional(),
  }),
});

module.exports = {
  z,
  idParam,
  branchParam,
  currency,
  paymentType,
  lockerStatus,
  lockerSize,
  orderStatus,
  optionalInt,
  amount,
  phone,
  listQuery,
};
