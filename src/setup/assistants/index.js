// @ts-check
// Supported assistants (README Q4). Add a module here to support another.
import claudeCode from './claude-code.js';
import cursor from './cursor.js';
import codex from './codex.js';
import gemini from './gemini.js';

/** @type {import('./common.js').Assistant[]} */
export const ASSISTANTS = [claudeCode, cursor, codex, gemini];
