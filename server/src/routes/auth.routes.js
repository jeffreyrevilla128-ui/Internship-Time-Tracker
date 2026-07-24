import express from 'express';
import authenticate from '../middleware/auth.middleware.js';
import {
  register,
  login,
  googleLogin,
  getMe,
} from '../controllers/auth.controller.js';

const router = express.Router();

// Existing authentication routes
router.post('/register', register);
router.post('/login', login);

// Google OAuth login route
router.post('/google', googleLogin);

// Protected — requires a valid Bearer token. Used by App.jsx on mount to
// verify a stored token is still valid and restore the session.
router.get('/me', authenticate, getMe);

export default router;