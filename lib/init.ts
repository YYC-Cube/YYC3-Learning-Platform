/**
 * @fileoverview 工具函数/库 · init.ts
 * @author YYC³ <admin@0379.email>
 * @version 1.0.0
 * @license MIT
 */
import { validateEnvConfig, getEnvInfo } from './env';
import { logError } from './error-handler';

let isInitialized = false;

/**
 * 初始化应用配置
 */
export function initializeApp(): void {
  if (isInitialized) {
    return;
  }

  try {
    validateEnvConfig();
    isInitialized = true;

    if (process.env.NODE_ENV === 'development') {
      const envInfo = getEnvInfo();
      console.warn('应用环境配置', envInfo);
    }
  } catch (error) {
    logError(error, { context: '应用初始化' });
    throw error;
  }
}

/**
 * 检查应用是否已初始化
 */
export function isAppInitialized(): boolean {
  return isInitialized;
}

/**
 * 获取应用初始化状态
 */
export function getInitializationStatus(): {
  initialized: boolean;
  envInfo?: Record<string, any>;
  error?: string;
} {
  if (isInitialized) {
    return {
      initialized: true,
      envInfo: getEnvInfo(),
    };
  }

  return {
    initialized: false,
    error: '应用尚未初始化',
  };
}
