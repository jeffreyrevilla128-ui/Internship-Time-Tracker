import { Router } from 'express';
import { checkGrammarHandler } from '../controllers/grammarController.js';

const grammarRoutes = Router();

grammarRoutes.post('/check', checkGrammarHandler);

export default grammarRoutes;