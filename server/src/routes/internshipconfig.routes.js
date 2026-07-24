import { Router } from 'express';
import authenticate from '../middleware/auth.middleware.js';
import * as internshipConfigController from '../controllers/internshipconfig.controller.js';

const router = Router();

// Every route here requires a valid JWT — req.user.id is how we scope
// the config to the logged-in intern, so there's no way to read or
// write another user's row.
router.use(authenticate);

router.get('/', internshipConfigController.getConfig);
router.put('/', internshipConfigController.upsertConfig);

export default router;