import * as attendanceService from '../services/attendance.service.js';

export async function getLogs(req, res) {
  try {
    const logs = await attendanceService.getAllLogsForUser(req.user.id);
    res.json({ logs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}

// Fetches the (possibly in-progress) attendance row for a single date —
// used by OJTDashboard on mount to seed shiftState after a page refresh.
export async function getDay(req, res) {
  try {
    const { date } = req.params;
    const log = await attendanceService.getDayForUser(req.user.id, date);
    res.json({ log }); // log is null if nothing recorded for that date yet
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}

export async function updateLog(req, res) {
  try {
    const { id } = req.params;
    const { amIn, amOut, pmIn, pmOut, diaryText } = req.body;

    const updated = await attendanceService.updateLogForUser(req.user.id, id, {
      amIn, amOut, pmIn, pmOut, diaryText,
    });

    if (!updated) {
      return res.status(404).json({ error: 'Attendance record not found' });
    }

    res.json({ log: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}

// Full day upsert (time fields + is_completed) — used only by PunchCard,
// which always has the complete current shiftState in scope.
export async function upsertDay(req, res) {
  try {
    const { date, amIn, amOut, pmIn, pmOut, isCompleted } = req.body;

    if (!date) {
      return res.status(400).json({ error: 'Missing date' });
    }

    const log = await attendanceService.upsertDayForUser(req.user.id, {
      date, amIn, amOut, pmIn, pmOut, isCompleted,
    });

    res.json({ log });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}

// Diary-only upsert — used by DiaryForm and PunchCard's quick-entry diary
// modal. Never touches time fields, so editing a past diary entry can
// never accidentally erase that day's recorded punches.
export async function upsertDiaryOnly(req, res) {
  try {
    const { date } = req.params;
    const { diaryText } = req.body;

    const result = await attendanceService.upsertDiaryOnlyForUser(req.user.id, date, diaryText);

    if (!result) {
      return res.status(404).json({ error: 'No attendance record exists for this date yet' });
    }

    res.json({ diary: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}

export async function deleteDiaryForDate(req, res) {
  try {
    const { date } = req.params;
    const deleted = await attendanceService.deleteDiaryForUserAndDate(req.user.id, date);

    if (!deleted) {
      return res.status(404).json({ error: 'Diary entry not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}

export async function deleteLog(req, res) {
  try {
    const { id } = req.params;
    const deleted = await attendanceService.deleteLogForUser(req.user.id, id);

    if (!deleted) {
      return res.status(404).json({ error: 'Attendance record not found' });
    }

    res.json({ success: true, id: deleted.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}