/**
 * 进程内写回互斥：重叠写回串行完整执行。
 * 锁覆盖原始树读取、快照、准备、替换、正式验证、回滚与故障状态更新。
 */
class ConfigWriteLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const previous = this.tail;
    this.tail = previous.then(
      () => gate,
      () => gate,
    );

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export const configWriteLock = new ConfigWriteLock();
