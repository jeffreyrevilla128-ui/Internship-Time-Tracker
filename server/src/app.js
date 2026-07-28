import express from 'express';
import cors from 'cors';

import authRoutes from './routes/auth.routes.js';
import attendanceRoutes from './routes/attendance.routes.js';
import internshipConfigRoutes from './routes/internshipconfig.routes.js';
import grammarRoutes from './routes/grammarRoutes.js';

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/internship-config', internshipConfigRoutes);
app.use('/api/grammar', grammarRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

export default app;