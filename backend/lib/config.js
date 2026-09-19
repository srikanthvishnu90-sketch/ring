// Shared config helpers: env access, missing-key detection, typed errors.
// Every connector uses these so "not configured" and "needs partnership"
// fail loudly and uniformly instead of mysteriously.
require('dotenv').config();

const env = (k, d = '') => process.env[k] || d;
const missing = (keys) => keys.filter((k) => !process.env[k]);

class NotConfigured extends Error {
  constructor(name, vars) {
    super(`${name} is not configured — set ${vars.join(', ')} (see .env.example)`);
    this.code = 'NOT_CONFIGURED';
    this.connector = name;
  }
}

class PartnershipRequired extends Error {
  constructor(name, detail) {
    super(`${name}: ${detail}`);
    this.code = 'PARTNERSHIP_REQUIRED';
    this.connector = name;
  }
}

module.exports = { env, missing, NotConfigured, PartnershipRequired };
