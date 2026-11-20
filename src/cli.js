#!/usr/bin/env node
// 命令行入口：读取抽象日志 JSON，输出重放分析报告。
// 用法：node src/cli.js [input.json]（省略路径或传 - 时从 stdin 读取）

import { readFile } from 'node:fs/promises';
import { analyzeReplay } from './replay-analyzer.js';

async function readInput() {
  const target = process.argv[2];
  if (target === '-' || (!target && !process.stdin.isTTY)) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  if (!target) {
    console.error('用法：node src/cli.js <input.json>（或通过管道传入 JSON，使用 - 显式读取 stdin）');
    process.exit(2);
  }
  return readFile(target, 'utf8');
}

try {
  const raw = await readInput();
  if (!raw.trim()) {
    console.error('错误：输入为空，期望一份 JSON 格式的抽象日志。');
    process.exit(2);
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch (error) {
    console.error(`错误：输入不是合法 JSON：${error.message}`);
    process.exit(2);
  }
  const report = analyzeReplay(input);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exit(1);
}
