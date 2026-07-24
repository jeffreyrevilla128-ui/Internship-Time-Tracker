import * as authService from '../services/auth.service.js';

const SPECIAL_CHAR_PATTERN = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/;

// Mirrors the frontend checklist in AuthPage.jsx so the rules can't be
// bypassed by calling the API directly (curl, Postman, etc).
function getPasswordIssues(password) {
  const issues = [];
  if (password.length < 8) issues.push('at least 8 characters');
  if (!/[A-Z]/.test(password)) issues.push('one uppercase letter');
  if (!/[a-z]/.test(password)) issues.push('one lowercase letter');
  if (!/[0-9]/.test(password)) issues.push('one number');
  if (!SPECIAL_CHAR_PATTERN.test(password)) issues.push('one special character');
  return issues;
}

export async function register(req, res) {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const passwordIssues = getPasswordIssues(password);
    if (passwordIssues.length > 0) {
      return res.status(400).json({
        error: `Password must contain ${passwordIssues.join(', ')}`,
      });
    }

    const existingEmail = await authService.findUserByEmail(email);
    if (existingEmail) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const existingUsername = await authService.findUserByIdentifier(username);
    if (existingUsername) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const user = await authService.createUser({ username, email, password });
    const token = authService.generateToken(user);

    res.status(201).json({ user, token });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username or email already registered' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}

export async function login(req, res) {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Missing identifier or password' });
    }

    const user = await authService.findUserByIdentifier(identifier);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await authService.validatePassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = authService.generateToken(user);
    delete user.password_hash;

    res.json({ user, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}

// GOOGLE OAUTH LOGIN
export async function googleLogin(req, res) {
  try {
    const { access_token } = req.body;

    if (!access_token) {
      return res.status(400).json({ error: 'Access token is required' });
    }

    // Get user info from Google
    const response = await fetch(
      `https://www.googleapis.com/oauth2/v3/userinfo?access_token=${access_token}`
    );

    const googleUser = await response.json();

    if (!googleUser.email) {
      return res.status(400).json({ error: 'Google authentication failed' });
    }

    // Check if user already exists
    let user = await authService.findUserByEmail(googleUser.email);

    // If not, create the user automatically
    if (!user) {
      const username =
        googleUser.name?.replace(/\s+/g, '').toLowerCase() ||
        googleUser.email.split('@')[0];

      // Generate a temporary password since Google users won't use local login
      const tempPassword =
        Math.random().toString(36).slice(-8) + 'Aa1!';

      user = await authService.createUser({
        username,
        email: googleUser.email,
        password: tempPassword,
      });
    }

    // Generate your app's JWT token
    const token = authService.generateToken(user);

    // Remove password hash before sending to frontend
    delete user.password_hash;

    res.json({ user, token });
  } catch (err) {
    console.error('Google login error:', err);
    res.status(500).json({ error: 'Google authentication failed' });
  }
}

// Protected by the `authenticate` middleware on the route, so req.user is
// already the decoded { id, role } payload by the time this runs.
export async function getMe(req, res) {
  try {
    const user = await authService.findUserById(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}