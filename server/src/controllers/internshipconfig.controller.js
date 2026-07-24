import * as internshipConfigService from '../services/internshipconfig.service.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function getConfig(req, res) {
  try {
    const config = await internshipConfigService.findConfigByUserId(req.user.id);

    if (!config) {
      // Not an error — a new user just hasn't set required hours / start
      // date yet. MetricHeader already renders "Set required hours" /
      // "Set a start date" when these are missing, so null is meaningful
      // data here, not a failure state.
      return res.json({ config: null });
    }

    res.json({ config });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}

export async function upsertConfig(req, res) {
  try {
    const { requiredHours, officialStartDate } = req.body;

    if (requiredHours === undefined || officialStartDate === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const hours = Number(requiredHours);
    if (!Number.isInteger(hours) || hours <= 0) {
      return res.status(400).json({ error: 'Required hours must be a positive whole number' });
    }

    if (typeof officialStartDate !== 'string' || !DATE_PATTERN.test(officialStartDate)) {
      return res.status(400).json({ error: 'Official start date must be in YYYY-MM-DD format' });
    }
    if (Number.isNaN(new Date(officialStartDate).getTime())) {
      return res.status(400).json({ error: 'Official start date is not a valid date' });
    }

    // user_id always comes from the verified JWT (req.user.id), never from
    // the request body — same principle as stripping `role` at registration.
    const config = await internshipConfigService.upsertConfig(req.user.id, {
      requiredHours: hours,
      officialStartDate,
    });

    res.json({ config });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}