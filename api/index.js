// Vercel serverless entry — the Express app handles /api/* via the rewrite
// in vercel.json. Static index.html is served from the project root.
module.exports = require('../backend/server.js');
