/**
 * bun:test → vitest 兼容 shim（分支覆盖复验通道）
 * bun 的 jest 命名空间映射到 vitest 的 vi
 */
export { describe, it, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { vi } from 'vitest';
export const jest = vi;
