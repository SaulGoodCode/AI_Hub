#!/usr/bin/env node
/**
 * 发布用：把 package.json 的 version 同步为当前 tag（去掉前导 v）。
 * 在 GitHub Actions 里由 workflow 调用（env.AIHUB_TAG = github.ref_name）。
 * 本地也可用：AIHUB_TAG=v0.1.0 node scripts/sync-version.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const tag = process.env.AIHUB_TAG;
if (!tag) {
  console.error('缺少 AIHUB_TAG 环境变量（应为 tag 名，如 v0.1.0）');
  process.exit(1);
}

const version = tag.replace(/^v/i, '');
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`无法从 tag 解析版本号: "${tag}"`);
  process.exit(1);
}

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`package.json version → ${version}`);
