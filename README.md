# 文件系统日志重放分析器

分析崩溃恢复场景下的抽象文件系统日志，根据 fsync 持久化边界、事务提交标记和目录项
依赖关系，计算**可安全重放的最长日志前缀**，并输出可应用操作、跳过记录、最终元数据
状态以及首次不安全点。

> 本工具只处理**抽象日志数据结构**（内存中的 JSON / 普通对象），不会挂载、读取或
> 修改任何真实文件系统，也不执行真实的 `rename`、`unlink`、`fsync` 等系统调用。
> 所有“目录项”和“元数据”都只是输入/输出中的普通映射表。

## 运行环境

- Node.js `v24.16.0`（`package.json` 的 `engines` 字段同样声明该版本要求）
- 无第三方依赖，仅使用 Node 内置模块

## 快速开始

```bash
# 分析一份抽象日志
node src/cli.js examples/journal.json

# 也可以通过标准输入传入
cat examples/journal.json | node src/cli.js -

# 运行测试
node --test
```

编程方式调用：

```js
import { analyzeReplay } from './src/replay-analyzer.js';

const report = analyzeReplay({
  metadata: { '/dir': { type: 'dir' } },
  appliedTxns: [],
  records: [
    { seq: 1, type: 'create', txn: 't1', path: '/dir/a' },
    { seq: 2, type: 'commit', txn: 't1' },
    { seq: 3, type: 'fsync' },
  ],
});
```

## 输入格式

`analyzeReplay(input)` 接收一个对象：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `records` | `object[]` | 按日志文件顺序排列的记录数组，每条记录含单调递增的 `seq` |
| `metadata` | `object` | 崩溃时已持久化的目录项映射，键为绝对路径，值为 `{ type, txn? }` |
| `appliedTxns` | `string[]` | 崩溃前已经生效的事务 id（用于重复回放的幂等判定） |
| `fsyncs` | `number[]` | 可选，日志之外额外声明的 fsync 边界（记录 `seq` 列表） |

支持的记录类型：

- 数据操作：`create`、`mkdir`、`write`、`rename`（含 `from`/`to`）、`unlink`
- 控制记录：`commit`（含 `txn`）、`fsync`
- 数据与提交记录都必须带事务 id `txn`；`rename` 可通过 `deps: string[]` 显式声明
  额外依赖路径

## 安全规则

1. **fsync 边界**：`seq` 不大于最后一个 fsync 边界的记录视为已持久化；边界之后的
   记录属于可能只写入了一半的易失尾部，标记为 `not-persisted`，绝不当成成功。
2. **提交原子性**：一个事务只有当其**数据记录和提交记录都跨过持久化边界**时才允许
   生效；数据已落盘但缺少提交记录时标记 `commit-missing`，整个事务不重放。
3. **目录/rename 依赖**：
   - `create`/`mkdir`/`write` 要求父目录存在，`write` 还要求目标项已存在；
   - `unlink` 要求父目录与目标项都存在；
   - `rename` 要求源项、源父目录和目标父目录都存在（目标路径已存在时允许覆盖）；
   - 依赖不满足时标记 `dependency-unsatisfied`，该事务整体回滚、不留部分状态，
     其后的事务全部保留不执行。
4. **幂等重放**：出现在 `appliedTxns` 中的事务在日志里再次出现时跳过，原语为
   `duplicate-replay`，已持久化的元数据不会被重复操作破坏。
5. **未知记录**：无法识别的类型标记 `unknown-record`，并作为首次不安全点处理，
   不会被乐观地当作成功记录。
6. **前缀语义**：首次不安全点之后的所有数据记录统一标记 `after-unsafe-point`，
   最终状态只反映此前确认安全的前缀。

## 输出格式

| 字段 | 说明 |
| --- | --- |
| `safePrefix.endSeq` | 可安全重放前缀的最后一个 `seq`；没有任何安全记录时为 `null` |
| `safePrefix.durableEndSeq` | 最后一个 fsync 边界的 `seq` |
| `appliedOperations` | 实际应用的数据操作（按重放顺序） |
| `appliedTransactions` | 本次重放生效的事务及其提交 `seq` |
| `skipped` | 跳过的数据记录及原因（`commit`/`fsync` 控制记录不计入） |
| `metadata` | 重放后的最终目录项映射（始终包含根目录 `/`） |
| `firstUnsafePoint` | 首次不安全点 `{ seq, reason, detail }`，日志完全安全时为 `null` |

跳过原因取值：`not-persisted`、`commit-missing`、`unknown-record`、
`malformed-record`、`dependency-unsatisfied`、`after-unsafe-point`、
`duplicate-replay`。

## 项目结构

```
src/replay-analyzer.js   # 纯函数核心：安全前缀计算与元数据重放
src/cli.js               # 命令行入口（读取 JSON，输出报告）
test/replay-analyzer.test.js  # node:test 测试（9 个用例）
examples/journal.json    # 示例抽象日志
```

## 测试覆盖

`node --test` 覆盖：完整事务重放、提交记录缺失、rename 源/目标父目录依赖、
重复事务幂等回放、日志尾部损坏、未知记录类型、无 fsync、多事务提交顺序与依赖失败、
以及 CLI 端到端输出。
