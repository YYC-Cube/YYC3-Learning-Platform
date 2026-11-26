/**
 * Wave-8b — 缓冲路径 dedupe/compress 开关（processChunk 分支 224-249）
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EnhancedStreamingProcessor } from './core/EnhancedStreamingProcessor';
import type { ModelRequest, ModelResponse } from './IModelAdapter';

const req = (id: string): ModelRequest => ({ id, taskType: 'generation', prompt: 'esp' } as any);
const chunk = (id: string, content: string): ModelResponse =>
  ({ requestId: id, content, metadata: {} } as any);

async function* gen(id: string): AsyncIterable<ModelResponse> {
  yield chunk(id, 'a');
}

describe('Wave-8b — 缓冲路径 dedupe/compress 开关（processChunk 分支）', () => {
  it('enableDeduplication+enableCompression 全开：重复/超长 chunk 分支', async () => {
    const esp = new EnhancedStreamingProcessor({
      enableBuffering: true,
      enableDeduplication: true,
      enableCompression: true,
    } as any);

    const got: string[] = [];
    const same = async function* (): AsyncIterable<ModelResponse> {
      yield chunk('d1', 'same-content');
      yield chunk('d2', 'same-content'); // dedupe 命中
      yield chunk('d3', 'x'.repeat(3000)); // compress 触发
    };
    await esp.processStream(req('dd'), () => same(), (c) => got.push(c.content ?? ''));
    expect(got.length).toBeGreaterThanOrEqual(2);
    await esp.cleanup();
  });

  it('流错误传播（直通路径 rejects，retry 关闭）', async () => {
    const esp = new EnhancedStreamingProcessor({ retryOnFailure: false } as any);
    (esp as any).config.enableBuffering = false;
    const boom = async function* (): AsyncIterable<ModelResponse> {
      throw new Error('direct boom');
    };
    await expect(esp.processStream(req('err'), () => boom(), () => {})).rejects.toThrow('direct boom');
    await esp.cleanup();
  });

  it('prefetch 超时清理（streamTimeout 边界语义）', async () => {
    const esp = new EnhancedStreamingProcessor({ streamTimeout: 50 } as any);
    (esp as any).config.enablePrefetch = true;
    const p = esp.prefetch(req('timeout-pf'), () => gen('timeout-pf'));
    await p;
    // prefetch 完成后 finally 清理（与 cleanup task 的过期删除语义一致）
    expect((esp as any).prefetchQueue.size).toBe(0);
    await esp.cleanup();
  });
});
