const router = require('express').Router();
const { z, amount, currency, paymentType } = require('../utils/validation');
const validate = require('../middleware/validate.middleware');
const { success, asyncHandler } = require('../utils/response');
const service = require('../services/financialApproval.service');
router.get('/orders/:id', asyncHandler(async (req, res) => success(res, await service.list(req.user, req.params.id))));
router.post('/orders/:id', validate(z.object({ body: z.object({
  kind: z.enum(['REFUND', 'PAYMENT_CORRECTION']), movementId: z.string().min(1),
  amount: amount.optional(), currency, newPaymentType: paymentType.optional(), reason: z.string().trim().min(1).max(2000),
}) })), asyncHandler(async (req, res) => success(res, await service.createRequest(req.user, req.params.id, req.body, req.get('Idempotency-Key')), 201)));
router.post('/:id/payout', validate(z.object({ body: z.object({ amount, currency, paymentType: paymentType.optional(), reference: z.string().trim().min(1).max(500) }) })),
  asyncHandler(async (req, res) => {
    require('../utils/idempotency').requireIdempotencyKey(req.get('Idempotency-Key'));
    success(res, await service.payout(req.user, req.params.id, req.body, req.get('Idempotency-Key')));
  }));
module.exports = router;
