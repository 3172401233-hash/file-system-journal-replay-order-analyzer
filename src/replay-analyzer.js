// 抽象文件系统日志重放分析器（纯函数实现，不触碰真实文件系统）。
// 输入一份抽象日志与崩溃时已持久化的状态，输出可安全重放的最长前缀。

export const RECORD_TYPES = Object.freeze({
  DATA: ['create', 'mkdir', 'write', 'rename', 'unlink'],
  FSYNC: 'fsync',
  COMMIT: 'commit',
});

const DATA_TYPES = new Set(RECORD_TYPES.DATA);

function parentOf(path) {
  const index = path.lastIndexOf('/');
  if (index <= 0) return '/';
  return path.slice(0, index);
}

// 对单条操作做静态依赖校验，返回缺失的依赖路径列表。
function missingDependencies(record, entries) {
  const missing = [];
  const requirePath = (path) => {
    if (!Object.hasOwn(entries, path)) missing.push(path);
  };

  const deps = Array.isArray(record.deps) ? record.deps : [];
  for (const dep of deps) {
    if (typeof dep === 'string') requirePath(dep);
  }

  switch (record.type) {
    case 'create':
    case 'mkdir':
    case 'write':
      requirePath(parentOf(record.path));
      if (record.type === 'write') requirePath(record.path);
      break;
    case 'unlink':
      requirePath(parentOf(record.path));
      requirePath(record.path);
      break;
    case 'rename':
      requirePath(record.from);
      requirePath(parentOf(record.from));
      requirePath(parentOf(record.to));
      break;
    default:
      break;
  }

  return [...new Set(missing)];
}

function applyOperation(record, entries) {
  switch (record.type) {
    case 'create':
    case 'mkdir':
      entries[record.path] = {
        type: record.type === 'mkdir' ? 'dir' : 'file',
        txn: record.txn,
      };
      break;
    case 'write':
      entries[record.path] = {
        ...entries[record.path],
        type: entries[record.path]?.type ?? 'file',
        txn: record.txn,
      };
      break;
    case 'unlink':
      delete entries[record.path];
      break;
    case 'rename': {
      const moved = entries[record.from];
      delete entries[record.from];
      entries[record.to] = { ...moved, txn: record.txn };
      break;
    }
    default:
      break;
  }
}

/**
 * 分析抽象日志，计算崩溃后可安全重放的最长前缀。
 *
 * @param {object} input
 * @param {Array<object>} input.records 按日志顺序排列的事务记录
 * @param {object} [input.metadata] 崩溃前已持久化的目录项映射
 * @param {string[]} [input.appliedTxns] 崩溃前已生效的事务 id
 * @param {number[]} [input.fsyncs] 额外的 fsync 边界（记录 seq 列表）
 * @returns {{
 *   safePrefix: {endSeq: number|null, durableEndSeq: number},
 *   appliedOperations: Array<object>,
 *   appliedTransactions: Array<{txn:string, commitSeq:number}>,
 *   skipped: Array<object>,
 *   metadata: object,
 *   firstUnsafePoint: object|null,
 * }}
 */
export function analyzeReplay(input = {}) {
  const records = Array.isArray(input.records) ? input.records : [];
  const entries = { '/': { type: 'dir' }, ...(input.metadata ?? {}) };
  const initiallyApplied = new Set(input.appliedTxns ?? []);
  // ---- Pass A：持久化边界 + 结构问题 -----------------------------------
  const issues = new Map(); // seq -> 首个问题
  const markIssue = (seq, reason, detail) => {
    if (!issues.has(seq)) issues.set(seq, { seq, reason, detail: detail ?? null });
  };

  let fsyncBoundary = 0;
  for (const boundary of input.fsyncs ?? []) {
    if (typeof boundary === 'number' && boundary > fsyncBoundary) fsyncBoundary = boundary;
  }
  // 日志内的 fsync 记录同样是持久化边界：seq 不大于该边界的记录都已落盘。
  for (const [index, record] of records.entries()) {
    if (record?.type !== 'fsync') continue;
    const seq = typeof record.seq === 'number' ? record.seq : index + 1;
    if (seq > fsyncBoundary) fsyncBoundary = seq;
  }

  const transactions = new Map(); // txn -> { seqs, commitSeq }
  const ensureTxn = (txn) => {
    if (!transactions.has(txn)) {
      transactions.set(txn, { seqs: [], commitSeq: null });
    }
    return transactions.get(txn);
  };

  records.forEach((record, index) => {
    const seq = typeof record?.seq === 'number' ? record.seq : index + 1;
    const type = record?.type;

    if (type === 'fsync') return;

    if (seq > fsyncBoundary) {
      markIssue(seq, 'not-persisted', '记录位于最后一个 fsync 边界之后，崩溃时可能未落盘');
      return;
    }

    const isData = DATA_TYPES.has(type);
    const isCommit = type === 'commit';
    if (!isData && !isCommit) {
      markIssue(seq, 'unknown-record', `未知或已损坏的记录类型: ${String(type)}`);
      return;
    }

    if (typeof record.txn !== 'string' || record.txn.length === 0) {
      markIssue(seq, 'malformed-record', '数据或提交记录缺少事务 id (txn)');
      return;
    }

    const txnInfo = ensureTxn(record.txn);
    txnInfo.seqs.push(seq);
    if (isCommit) {
      if (txnInfo.commitSeq === null) txnInfo.commitSeq = seq;
    }
  });

  const durableEndSeq = fsyncBoundary;

  // ---- Pass B：提交完整性（数据与提交记录都必须跨过 fsync 边界） --------
  for (const [txn, info] of transactions) {
    if (initiallyApplied.has(txn)) continue;
    if (info.commitSeq === null) {
      const earliest = Math.min(...info.seqs);
      markIssue(earliest, 'commit-missing', `事务 ${txn} 的数据已落盘，但缺少持久化的提交记录`);
    }
  }

  const structuralCutoff = (() => {
    if (issues.size === 0) return fsyncBoundary;
    return Math.min(...issues.keys()) - 1;
  })();
  const safePrefixEndSeq = Math.max(0, structuralCutoff);

  // ---- Pass C：按提交顺序原子重放，动态校验目录/rename 依赖 -------------
  const eligible = [...transactions.entries()]
    .filter(([txn, info]) => {
      if (initiallyApplied.has(txn)) return false;
      if (info.commitSeq === null) return false;
      return info.seqs.every((seq) => seq <= safePrefixEndSeq);
    })
    .sort((a, b) => a[1].commitSeq - b[1].commitSeq);

  const appliedOperations = [];
  const appliedTransactions = [];
  let dependencyFailure = null;

  for (const [txn, info] of eligible) {
    const txnRecords = records
      .filter((record) => record.txn === txn
        && DATA_TYPES.has(record.type)
        && record.seq <= safePrefixEndSeq)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

    // 逐条校验并应用：同一事务内的后序操作可以看到前序操作的效果。
    // 一旦依赖不满足就整体回滚该事务，保证事务原子性。
    const snapshot = structuredClone(entries);
    const staged = [];
    let failedOn = null;
    for (const record of txnRecords) {
      const missing = missingDependencies(record, entries);
      if (missing.length > 0) {
        failedOn = { record, missing };
        break;
      }
      applyOperation(record, entries);
      staged.push(record);
    }

    if (failedOn) {
      Object.keys(entries).forEach((key) => delete entries[key]);
      Object.assign(entries, snapshot);
      dependencyFailure = {
        seq: failedOn.record.seq,
        reason: 'dependency-unsatisfied',
        detail: {
          txn,
          op: failedOn.record.type,
          missing: failedOn.missing,
        },
      };
      break;
    }

    for (const record of staged) {
      appliedOperations.push({
        seq: record.seq,
        txn,
        type: record.type,
        path: record.path ?? null,
        from: record.from ?? null,
        to: record.to ?? null,
      });
    }
    appliedTransactions.push({ txn, commitSeq: info.commitSeq });
  }

  let finalCutoff = safePrefixEndSeq;
  if (dependencyFailure) finalCutoff = Math.min(finalCutoff, dependencyFailure.seq - 1);

  const firstUnsafePoint = (() => {
    const earliestIssue = issues.size > 0
      ? issues.get(Math.min(...issues.keys()))
      : null;
    if (earliestIssue && dependencyFailure) {
      return earliestIssue.seq <= dependencyFailure.seq ? earliestIssue : dependencyFailure;
    }
    return earliestIssue ?? dependencyFailure;
  })();

  // ---- 汇总跳过记录 ----------------------------------------------------
  const skipped = [];
  records.forEach((record, index) => {
    const seq = typeof record?.seq === 'number' ? record.seq : index + 1;
    if (record?.type === 'fsync' || record?.type === 'commit') return;

    const issue = issues.get(seq);
    if (issue) {
      skipped.push({
        seq,
        txn: typeof record?.txn === 'string' ? record.txn : null,
        type: record?.type ?? null,
        reason: issue.reason,
        detail: issue.detail,
      });
      return;
    }

    if (seq > finalCutoff) {
      skipped.push({
        seq,
        txn: typeof record?.txn === 'string' ? record.txn : null,
        type: record?.type ?? null,
        reason: 'after-unsafe-point',
        detail: '位于首次不安全点之后，保留此前安全状态',
      });
      return;
    }

    if (typeof record?.txn === 'string' && initiallyApplied.has(record.txn)) {
      skipped.push({
        seq,
        txn: record.txn,
        type: record.type,
        reason: 'duplicate-replay',
        detail: '事务在崩溃前已生效，重放按幂等处理',
      });
    }
  });

  return {
    safePrefix: {
      endSeq: finalCutoff === 0 ? null : finalCutoff,
      durableEndSeq,
    },
    appliedOperations,
    appliedTransactions,
    skipped,
    metadata: entries,
    firstUnsafePoint,
  };
}

export default analyzeReplay;
