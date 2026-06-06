const expenseService = require("../services/expense.service");
const { success, asyncHandler } = require("../utils/response");

const list = asyncHandler(async (req, res) => success(res, await expenseService.listExpenses(req.user, req.query)));
const create = asyncHandler(async (req, res) => success(res, await expenseService.createExpense(req.user, req.body), 201));
const remove = asyncHandler(async (req, res) => success(res, await expenseService.deleteExpense(req.user, req.params.id)));

module.exports = { list, create, remove };
