import jwt from 'jsonwebtoken';

export default function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('[auth.middleware] No Authorization header or wrong format:', authHeader);
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    // TEMPORARY: logs the real jsonwebtoken error (e.g. "invalid signature",
    // "jwt expired", "jwt malformed") so we can pinpoint the actual cause
    // instead of guessing from the generic response message alone.
    console.log('[auth.middleware] jwt.verify failed:', err.name, '-', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}