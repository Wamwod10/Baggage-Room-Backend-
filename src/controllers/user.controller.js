const userService = require("../services/user.service");
const { success, asyncHandler } = require("../utils/response");

const list = asyncHandler(async (req, res) => success(res, await userService.listUsers(req.user, req.query)));
const create = asyncHandler(async (req, res) => success(res, await userService.createUser(req.user, req.body), 201));
const update = asyncHandler(async (req, res) => success(res, await userService.updateUser(req.user, req.params.id, req.body)));

module.exports = { list, create, update };
