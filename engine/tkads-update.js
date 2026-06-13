#!/usr/bin/env node
/**
 * tkads-update.js — 改 ROI（保持兼容，实际调用统一引擎）
 * 用法: node tkads-update.js <campaign_id> <roi> [budget]
 */
const { execSync } = require('child_process');
const home = process.env.HOME || process.env.USERPROFILE || '~';
execSync(`node ${home}/.tkads/tkads.js update ${process.argv.slice(2).join(' ')}`, { stdio: 'inherit', timeout: 60000 });
