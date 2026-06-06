const router = require("express").Router();
const branchController = require("../controllers/branch.controller");

router.get("/", branchController.list);

module.exports = router;
