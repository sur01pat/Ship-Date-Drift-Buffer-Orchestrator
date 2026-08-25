require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 4000,
  JWT_SECRET: process.env.JWT_SECRET || 'enterprise-orchestrator-secret-key-2024',
  JWT_EXPIRY: parseInt(process.env.JWT_EXPIRY || '3600', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  DB_PATH: process.env.DB_PATH || './data/orchestrator.db',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
};
