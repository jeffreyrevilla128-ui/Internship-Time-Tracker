import express from 'express';
import authenticate from '../middleware/auth.middleware.js';
import {
  getLogs,
  getDay,
  updateLog,
  deleteLog,
  upsertDay,
  upsertDiaryOnly,
  deleteDiaryForDate,
} from '../controllers/attendance.controller.js';

const router = express.Router();

// Every route here requires a valid JWT — req.user.id is injected by
// the middleware and used to scope every query to the logged-in user.
router.use(authenticate);

router.get('/', getLogs);

// Single-date lookup — used by OJTDashboard on mount to seed shiftState
// (today's in-progress punches, if any) after a page refresh.
router.get('/day/:date', getDay);

// Date-keyed upsert — used by PunchCard (clock in/out), since it doesn't
// know an attendance id up front on the first punch of a new day.
router.put('/day', upsertDay);

// Diary-only upsert/delete — used by DiaryForm and PunchCard's diary
// modal. Never touches time fields, so it can't accidentally erase a
// day's recorded punches.
router.put('/day/:date/diary', upsertDiaryOnly);
router.delete('/day/:date/diary', deleteDiaryForDate);

// Id-keyed edit/delete — used by HistoryLogs, which is always operating
// on an attendance row it already fetched (and therefore has the id for).
router.put('/:id', updateLog);
router.delete('/:id', deleteLog);

export default router;