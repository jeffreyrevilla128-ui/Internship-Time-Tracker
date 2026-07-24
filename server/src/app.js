import express from 'express';
import cors from 'cors';

import authRoutes from './routes/auth.routes.js';
import attendanceRoutes from './routes/attendance.routes.js';
import internshipConfigRoutes from './routes/internshipconfig.routes.js';

const app = express();

// Adjust this if your React dev server runs on a different port.
// Vite defaults to 5173, Create React App defaults to 3000.
const corsOptions = {
  origin: 'http://localhost:5173',
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/internship-config', internshipConfigRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

export default app;