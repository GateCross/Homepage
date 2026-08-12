/**
 * 进程内配置读写锁。
 * - 读可并发；写独占
 * - 写覆盖：原始树读取、快照、准备、替换、正式验证、回滚
 * - 读覆盖：loadConfig / getEditableConfig 整次五文件解析
 * 避免五次 rename 窗口内读到新旧混版快照。
 */
class ConfigRwLock {
  private activeReaders = 0;
  private activeWriter = false;
  private readonly waiters: Array<{
    kind: "read" | "write";
    resume: () => void;
  }> = [];

  private pump(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters[0];
      if (next === undefined) break;
      if (next.kind === "write") {
        if (this.activeReaders > 0 || this.activeWriter) break;
        this.waiters.shift();
        this.activeWriter = true;
        next.resume();
        break;
      }
      if (this.activeWriter) break;
      this.waiters.shift();
      this.activeReaders += 1;
      next.resume();
    }
  }

  async runRead<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeWriter || this.waiters.some((w) => w.kind === "write")) {
      await new Promise<void>((resolve) => {
        this.waiters.push({ kind: "read", resume: resolve });
      });
    } else {
      this.activeReaders += 1;
    }
    try {
      return await fn();
    } finally {
      this.activeReaders -= 1;
      this.pump();
    }
  }

  async runWrite<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeReaders > 0 || this.activeWriter || this.waiters.length > 0) {
      await new Promise<void>((resolve) => {
        this.waiters.push({ kind: "write", resume: resolve });
      });
    } else {
      this.activeWriter = true;
    }
    try {
      return await fn();
    } finally {
      this.activeWriter = false;
      this.pump();
    }
  }

  /** 兼容旧名：写路径 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    return this.runWrite(fn);
  }
}

export const configWriteLock = new ConfigRwLock();
