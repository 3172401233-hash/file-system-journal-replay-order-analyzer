import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { analyzeReplay } from '../src/replay-analyzer.js';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, '..', 'src', 'cli.js');

function seqs(report, key) {
  return report[key].map((item) => item.seq);
}

test('完整事务：数据与提交均跨过 fsync 边界时整体生效', () => {
  const report = analyzeReplay({
    records: [
      { seq: 1, type: 'create', txn: 't1', path: '/a' },
      { seq: 2, type: 'write', txn: 't1', path: '/a' },
      { seq: 3, type: 'fsync' },
      { seq: 4, type: 'commit', txn: 't1' },
      { seq: 5, type: 'fsync' },
    ],
  });

  assert.equal(report.firstUnsafePoint, null);
  assert.equal(report.safePrefix.endSeq, 5);
  assert.deepEqual(seqs(report, 'appliedOperations'), [1, 2]);
  assert.deepEqual(report.appliedTransactions, [{ txn: 't1', commitSeq: 4 }]);
  assert.equal(report.metadata['/a'].txn, 't1');
  assert.deepEqual(report.skipped, []);
});

test('提交记录缺失：只有数据落盘时事务不得生效', () => {
  const report = analyzeReplay({
    records: [
      { seq: 1, type: 'create', txn: 't1', path: '/a' },
      { seq: 2, type: 'fsync' },
      // t1 的提交记录从未写入
      { seq: 3, type: 'create', txn: 't2', path: '/b' },
      { seq: 4, type: 'commit', txn: 't2' },
      { seq: 5, type: 'fsync' },
    ],
  });

  assert.equal(report.firstUnsafePoint.seq, 1);
  assert.equal(report.firstUnsafePoint.reason, 'commit-missing');
  assert.equal(report.safePrefix.endSeq, null);
  assert.deepEqual(report.appliedOperations, []);
  assert.equal(report.metadata['/a'], undefined);
  assert.equal(report.metadata['/b'], undefined);
  assert.ok(report.skipped.some((item) => item.seq === 1 && item.reason === 'commit-missing'));
  assert.ok(report.skipped.some((item) => item.seq === 3 && item.reason === 'after-unsafe-point'));
});

test('rename 依赖：源项与目标父目录都存在才能重放，事务保持原子性', () => {
  const success = analyzeReplay({
    metadata: { '/dir': { type: 'dir' }, '/old': { type: 'file' } },
    records: [
      { seq: 1, type: 'rename', txn: 't1', from: '/old', to: '/dir/new' },
      { seq: 2, type: 'commit', txn: 't1' },
      { seq: 3, type: 'fsync' },
    ],
  });
  assert.equal(success.firstUnsafePoint, null);
  assert.equal(success.metadata['/old'], undefined);
  assert.equal(success.metadata['/dir/new'].type, 'file');

  const missingTargetParent = analyzeReplay({
    metadata: { '/old': { type: 'file' } },
    records: [
      { seq: 1, type: 'rename', txn: 't1', from: '/old', to: '/dir/new' },
      { seq: 2, type: 'commit', txn: 't1' },
      { seq: 3, type: 'fsync' },
    ],
  });
  assert.equal(missingTargetParent.firstUnsafePoint.seq, 1);
  assert.equal(missingTargetParent.firstUnsafePoint.reason, 'dependency-unsatisfied');
  assert.deepEqual(missingTargetParent.firstUnsafePoint.detail.missing, ['/dir']);
  assert.deepEqual(missingTargetParent.appliedOperations, []);
  // 失败的 rename 不得留下部分状态
  assert.equal(missingTargetParent.metadata['/old'].type, 'file');
  assert.equal(missingTargetParent.metadata['/dir/new'], undefined);

  const missingSource = analyzeReplay({
    metadata: { '/dir': { type: 'dir' } },
    records: [
      { seq: 1, type: 'rename', txn: 't1', from: '/old', to: '/dir/new' },
      { seq: 2, type: 'commit', txn: 't1' },
      { seq: 3, type: 'fsync' },
    ],
  });
  assert.deepEqual(missingSource.firstUnsafePoint.detail.missing, ['/old']);
});

test('重复回放：崩溃前已生效的事务再次出现时按幂等跳过', () => {
  const report = analyzeReplay({
    metadata: { '/a': { type: 'file', txn: 't1' } },
    appliedTxns: ['t1'],
    records: [
      { seq: 1, type: 'create', txn: 't1', path: '/a' },
      { seq: 2, type: 'commit', txn: 't1' },
      { seq: 3, type: 'fsync' },
      { seq: 4, type: 'create', txn: 't2', path: '/b' },
      { seq: 5, type: 'commit', txn: 't2' },
      { seq: 6, type: 'fsync' },
    ],
  });

  assert.equal(report.firstUnsafePoint, null);
  assert.deepEqual(seqs(report, 'appliedOperations'), [4]);
  assert.deepEqual(report.appliedTransactions.map((item) => item.txn), ['t2']);
  const dup = report.skipped.find((item) => item.seq === 1);
  assert.equal(dup.reason, 'duplicate-replay');
  assert.equal(report.metadata['/a'].txn, 't1');
  assert.equal(report.metadata['/b'].txn, 't2');
});

test('尾部损坏：fsync 之后的记录不被信任，此前安全状态完整保留', () => {
  const report = analyzeReplay({
    records: [
      { seq: 1, type: 'create', txn: 't1', path: '/a' },
      { seq: 2, type: 'commit', txn: 't1' },
      { seq: 3, type: 'fsync' },
      // 崩溃时只写入了一半、未跨过任何 fsync 边界
      { seq: 4, type: 'create', txn: 't2', path: '/b' },
    ],
  });

  assert.equal(report.firstUnsafePoint.seq, 4);
  assert.equal(report.firstUnsafePoint.reason, 'not-persisted');
  assert.equal(report.safePrefix.endSeq, 3);
  assert.deepEqual(seqs(report, 'appliedOperations'), [1]);
  assert.equal(report.metadata['/a'].txn, 't1');
  assert.equal(report.metadata['/b'], undefined);
  assert.ok(report.skipped.some((item) => item.seq === 4 && item.reason === 'not-persisted'));
});

test('未知记录不能当成成功：损坏的记录类型触发首次不安全点', () => {
  const report = analyzeReplay({
    records: [
      { seq: 1, type: 'create', txn: 't1', path: '/a' },
      { seq: 2, type: 'commit', txn: 't1' },
      { seq: 3, type: 'fsync' },
      { seq: 4, type: 'wtf-is-this', txn: 't2' },
      { seq: 5, type: 'fsync' },
    ],
  });

  assert.equal(report.firstUnsafePoint.seq, 4);
  assert.equal(report.firstUnsafePoint.reason, 'unknown-record');
  assert.equal(report.safePrefix.endSeq, 3);
  assert.deepEqual(seqs(report, 'appliedOperations'), [1]);
  assert.ok(report.skipped.some((item) => item.seq === 4 && item.reason === 'unknown-record'));
});

test('没有任何 fsync 时所有记录都视为未持久化', () => {
  const report = analyzeReplay({
    records: [
      { seq: 1, type: 'create', txn: 't1', path: '/a' },
      { seq: 2, type: 'commit', txn: 't1' },
    ],
  });

  assert.equal(report.safePrefix.endSeq, null);
  assert.deepEqual(report.appliedOperations, []);
  assert.equal(report.metadata['/a'], undefined);
  assert.equal(report.firstUnsafePoint.reason, 'not-persisted');
});

test('多个已提交事务按提交顺序重放，失败事务之后的事务全部保留', () => {
  const report = analyzeReplay({
    records: [
      { seq: 1, type: 'create', txn: 't1', path: '/a' },
      { seq: 2, type: 'commit', txn: 't1' },
      { seq: 3, type: 'unlink', txn: 't2', path: '/missing' },
      { seq: 4, type: 'commit', txn: 't2' },
      { seq: 5, type: 'create', txn: 't3', path: '/c' },
      { seq: 6, type: 'commit', txn: 't3' },
      { seq: 7, type: 'fsync' },
    ],
  });

  assert.deepEqual(seqs(report, 'appliedOperations'), [1]);
  assert.equal(report.firstUnsafePoint.seq, 3);
  assert.equal(report.firstUnsafePoint.reason, 'dependency-unsatisfied');
  assert.equal(report.metadata['/a'].txn, 't1');
  assert.equal(report.metadata['/c'], undefined);
  assert.deepEqual(report.skipped.map((item) => item.seq), [3, 5]);
});

test('CLI：从文件读取抽象日志并输出 JSON 报告', async () => {
  const inputPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), 'journal-replay-')),
    'input.json',
  );
  await fs.writeFile(inputPath, JSON.stringify({
    records: [
      { seq: 1, type: 'create', txn: 't1', path: '/a' },
      { seq: 2, type: 'commit', txn: 't1' },
      { seq: 3, type: 'fsync' },
    ],
  }));
  const { stdout } = await execFileAsync(process.execPath, [cliPath, inputPath]);
  const report = JSON.parse(stdout);
  assert.equal(report.firstUnsafePoint, null);
  assert.equal(report.metadata['/a'].txn, 't1');
});

test('同一事务内的依赖链：先 mkdir 再 rename 时后序操作可见前序效果', () => {
  const report = analyzeReplay({
    records: [
      { seq: 1, type: 'mkdir', txn: 't1', path: '/d' },
      { seq: 2, type: 'create', txn: 't1', path: '/f' },
      { seq: 3, type: 'rename', txn: 't1', from: '/f', to: '/d/f' },
      { seq: 4, type: 'commit', txn: 't1' },
      { seq: 5, type: 'fsync' },
    ],
  });

  assert.equal(report.firstUnsafePoint, null);
  assert.deepEqual(seqs(report, 'appliedOperations'), [1, 2, 3]);
  assert.equal(report.metadata['/f'], undefined);
  assert.equal(report.metadata['/d'].type, 'dir');
  assert.equal(report.metadata['/d/f'].type, 'file');
});

test('显式 deps 未满足时按依赖失败处理', () => {
  const report = analyzeReplay({
    records: [
      { seq: 1, type: 'create', txn: 't1', path: '/a', deps: ['/missing-parent'] },
      { seq: 2, type: 'commit', txn: 't1' },
      { seq: 3, type: 'fsync' },
    ],
  });

  assert.equal(report.firstUnsafePoint.reason, 'dependency-unsatisfied');
  assert.deepEqual(report.firstUnsafePoint.detail.missing, ['/missing-parent']);
  assert.deepEqual(report.appliedOperations, []);
  assert.equal(report.metadata['/a'], undefined);
});
