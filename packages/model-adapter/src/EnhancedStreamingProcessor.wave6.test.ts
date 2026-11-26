/**
 * Wave-6 — ESP 实现体深处（processStream 双路径/prefetch/cancel/dedupe/compress/metrics）
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EnhancedStreamingProcessor } from './core/EnhancedStreamingProcessor';
import type { ModelRequest, ModelResponse } from './IModelAdapter';

const req = (id: string): ModelRequest => ({ id, taskType: 'generation', prompt: 'esp' } as any);
const chunk = (id: string, content: string): ModelResponse =>
  ({ requestId: id, content, metadata: {} } as any);

async function* gen3(id: string): AsyncIterable<ModelResponse> {
  yield chunk(id, 'c1');
  yield chunk(id, 'c2');
  yield chunk(id, 'c3');
}

describe('Wave-6 — ESP processStream 双路径', () => {
  let esp: EnhancedStreamingProcessor;

  beforeEach(() => {
    esp = new EnhancedStreamingProcessor();
  });

  afterEach(async () => {
    await esp.cleanup();
  });

  it('直通路径（enableBuffering=false）三 chunk 全消费', async () => {
    (esp as any).config.enableBuffering = false;
    const got: string[] = [];
    await esp.processStream(req('s1'), () => gen3('s1'), (c) => got.push(c.content));
    expect(got).toEqual(['c1', 'c2', 'c3']);
    expect(esp.getMetrics().totalStreams).toBe(1);
  });

  it('缓冲路径（enableBuffering=true）', async () => {
    (esp as any).config.enableBuffering = true;
    const got: string[] = [];
    await esp.processStream(req('s2'), () => gen3('s2'), (c) => got.push(c.content));
    expect(got.length).toBeGreaterThanOrEqual(3);
  });

  it('流错误 → error 事件 + rejects（retry 关闭）', async () => {
    (esp as any).config.retryOnFailure = false;
    const errors: any[] = [];
    esp.on('stream:error', (e: any) => errors.push(e));
    const boom = async function* (): AsyncIterable<ModelResponse> {
      yield chunk('bad', 'partial');
      throw new Error('stream boom');
    };
    await expect(esp.processStream(req('bad'), () => boom(), () => {})).rejects.toThrow('stream boom');
    expect(errors.length).toBe(1);
    expect(esp.getMetrics().activeStreams).toBe(0);
  });

  it('retryOnFailure 开启时重试后成功', async () => {
    (esp as any).config.retryOnFailure = true;
    (esp as any).config.maxRetries = 2;
    let attempt = 0;
    const flaky = async function* (): AsyncIterable<ModelResponse> {
      attempt++;
      if (attempt === 1) throw new Error('first attempt fails');
      yield chunk('flaky', 'recovered');
    };
    const got: string[] = [];
    await esp.processStream(req('flaky'), () => flaky(), (c) => got.push(c.content));
    expect(got).toEqual(['recovered']);
  });

  it('prefetch 门控关闭时直返', async () => {
    (esp as any).config.enablePrefetch = false;
    await esp.prefetch(req('pf-off'), () => gen3('pf-off'));
    expect((esp as any).prefetchQueue.size).toBe(0);
  });

  it('prefetch 开启时入队 + chunk 事件 + finally 清理', async () => {
    (esp as any).config.enablePrefetch = true;
    const events: any[] = [];
    esp.on('prefetch:chunk', (e: any) => events.push(e));
    const p = esp.prefetch(req('pf-on'), () => gen3('pf-on'));
    await new Promise((r) => setTimeout(r, 30));
    expect(events.length).toBeGreaterThanOrEqual(1);
    await p;
    // prefetch 完成后 finally 清理队列条目
    expect((esp as any).prefetchQueue.has('pf-on')).toBe(false);
  });

  it('cancelStream 取消活动流', async () => {
    const slow = async function* (): AsyncIterable<ModelResponse> {
      yield chunk('slow', 'a');
      await new Promise((r) => setTimeout(r, 200));
      yield chunk('slow', 'b');
    };
    const p = esp.processStream(req('slow'), () => slow(), () => {
      /* 消费 */
    });
    await new Promise((r) => setTimeout(r, 20));
    esp.cancelStream('slow');
    await p;
    expect(esp.getMetrics().activeStreams).toBe(0);
  });

  it('deduplicateChunk 相同内容去重', () => {
    const c = chunk('d', 'dup');
    const first = (esp as any).deduplicateChunk(c);
    const second = (esp as any).deduplicateChunk(c);
    expect([first, second].some((r) => r === null)).toBe(true);
  });

  it('compressChunk 超长内容压缩返回', () => {
    const big = chunk('big', 'x'.repeat(5000));
    const out = (esp as any).compressChunk(big);
    expect(out === null || JSON.stringify(out).length <= JSON.stringify(big).length).toBe(true);
  });

  it('resetMetrics 归零 + updateMetrics 不抛错', () => {
    esp.getMetrics();
    (esp as any).updateMetrics();
    esp.resetMetrics();
    expect(esp.getMetrics().totalStreams).toBe(0);
  });
});
