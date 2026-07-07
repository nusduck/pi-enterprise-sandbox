/**
 * Shared configuration for the API Server.
 * All environment variable reads are centralized here.
 */
import { existsSync, readFileSync } from 'fs';

export const config = {
  PORT: parseInt(process.env.PORT, 10) || 4000,
  SANDBOX_BASE_URL: process.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
  SANDBOX_API_TOKEN: process.env.SANDBOX_API_TOKEN || '',
  LLMIO_BASE_URL: process.env.LLMIO_BASE_URL || '',
  LLMIO_API_KEY: process.env.LLMIO_API_KEY || '',
  MODEL_ID: process.env.MODEL_ID || 'deepseek-v4-flash',
  NODE_ENV: process.env.NODE_ENV || 'development',
};

export const AUTH_HEADER = config.SANDBOX_API_TOKEN
  ? { 'X-API-Key': config.SANDBOX_API_TOKEN }
  : {};
