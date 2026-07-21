import {
  createConfigFaultedError,
  CONFIG_FAULTED_MESSAGE,
} from "./helpers.js";
import { loadConfig, type LoadConfigOptions } from "../load-config.js";

/**
 * 进程内配置故障闸门。
 * 回滚失败或回滚后旧配置验证失败时开启；
 * 仅在磁盘恢复且完整 loadConfig 成功后解除。
 */
class ConfigFaultGate {
  private faulted = false;
  private reason: string = CONFIG_FAULTED_MESSAGE;

  isFaulted(): boolean {
    return this.faulted;
  }

  getReason(): string {
    return this.reason;
  }

  open(reason: string = CONFIG_FAULTED_MESSAGE): void {
    this.faulted = true;
    this.reason = reason;
  }

  close(): void {
    this.faulted = false;
    this.reason = CONFIG_FAULTED_MESSAGE;
  }

  /** 若闸门开启则抛出 CONFIG_FAULTED */
  assertOpen(): void {
    if (this.faulted) {
      throw createConfigFaultedError(this.reason);
    }
  }

  /**
   * 尝试通过完整 loadConfig 解除闸门。
   * 成功则关闭闸门并返回 true；失败保持开启。
   */
  async tryRecover(options: LoadConfigOptions = {}): Promise<boolean> {
    if (!this.faulted) return true;
    try {
      await loadConfig(options);
      this.close();
      return true;
    } catch {
      return false;
    }
  }
}

export const configFaultGate = new ConfigFaultGate();

export type { ConfigFaultGate };
