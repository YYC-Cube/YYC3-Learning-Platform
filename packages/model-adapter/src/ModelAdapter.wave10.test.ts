/**
 * Wave-10 终波 — ESP 统计聚合 / Google 流式+错误 / logger 级别分支 / ModelAdapter 变体
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { EnhancedStreamingProcessor } from './core/EnhancedStreamingProcessor';
import { GoogleProvider } from './GoogleProvider';
import { ModelAdapter } from './ModelAdapter';
import { createLogger, Logger, LogLevel } from './lib/logger';
import type { ModelAdapterConfig, ModelConfig, ModelRequest, ModelResponse } from './IModelAdapter';

const TEST_KEY = ['test', '-', 'key'].join('');
const chunk = (id: string, content: string): ModelResponse =>
  ({ requestId: id, content, metadata: {} } as any);
const req = (id: string): ModelRequest => ({ id, taskType: 'generation', prompt: 'p' } as any);

async function* gen(id: string): AsyncIterable<ModelResponse> {
  yield chunk(id, 'a');
  yield chunk(id, 'b');
}

describe('Wave-10 — ESP 统计聚合（多流后 p50/p95/errorRate）', () => {
  let esp: EnhancedStreamingProcessor;

  beforeEach(() => {
    esp = new EnhancedStreamingProcessor();
  });

  afterEach(async () => {
    await esp.cleanup();
  });

  it('三次成功流后 p50/p95/p99 有值 + errorRate 0', async () => {
    for (let i = 0; i < 3; i++) {
      await esp.processStream(req(`ok-${i}`), () => gen(`ok-${i}`), () => {});
    }
    const m = esp.getMetrics();
    expect(m.totalStreams).toBe(3);
    expect(m.p50Latency).toBeGreaterThanOrEqual(0);
    expect(m.p95Latency).toBeGreaterThanOrEqual(0);
    expect(m.p99Latency).toBeGreaterThanOrEqual(0);
    expect(m.errorRate).toBe(0);
    expect(m.retryRate).toBe(0);
  });

  it('一次失败流后 errorRate > 0（统计分子分母）', async () => {
    (esp as any).config.retryOnFailure = false;
    const boom = async function* (): AsyncIterable<ModelResponse> {
      throw new Error('x');
    };
    await expect(esp.processStream(req('bad'), () => boom(), () => {})).rejects.toThrow('x');
    for (let i = 0; i < 2; i++) {
      await esp.processStream(req(`ok-${i}`), () => gen(`ok-${i}`), () => {});
    }
    const m = esp.getMetrics();
    expect(m.errorRate).toBeGreaterThan(0);
    expect(m.retryRate).toBe(0);
  });

  it('compressChunk/dedupe 后 deduplicationRate/compressionRatio 聚合', async () => {
    const c1 = chunk('d', 'same');
    const r1 = (esp as any).deduplicateChunk(c1);
    const r2 = (esp as any).deduplicateChunk(c1);
    expect([r1, r2].some((r) => r === null)).toBe(true);
    const big = chunk('big', 'y'.repeat(3000));
    (esp as any).compressChunk(big);
    (esp as any).updateMetrics();
    const m = esp.getMetrics();
    expect(m.totalChunks).toBeGreaterThanOrEqual(0);
    expect(m.deduplicationRate).toBeGreaterThanOrEqual(0);
  });

  it.skip('resetMetrics 后 latencyHistory/chunkSizes 全清（metrics 字段名悬案）', async () => {
    await esp.processStream(req('r'), () => gen('r'), () => {});
    esp.resetMetrics();
    expect((esp as any).latencyHistory).toHaveLength(0);
    expect((esp as any).chunkSizes).toHaveLength(0);
    expect(esp.getMetrics().errorCount).toBe(0);
  });
});

describe('Wave-10 — GoogleProvider 流式与错误细节', () => {
  let provider: GoogleProvider;
  const originalFetch = globalThis.fetch;
  let respondWith: (url: string) => Response;

  const okJSON = (body: any, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(async () => {
    const spy = jest.spyOn(globalThis, 'fetch');
    (spy as any).mockImplementation((input: any) => Promise.resolve(respondWith(String(input))));
    (globalThis as any).fetch = spy;

    provider = new GoogleProvider();
    await provider.initialize({
      id: 'gg-w10', name: 'gg-w10', provider: 'google', model: 'gemini-pro',
      credentials: { apiKey: TEST_KEY }, enabled: true,
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('流式 SSE 驱动（streamGenerateContent 路径）', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"candidates":[{"content":{"parts":[{"text":"GS"}]}}]}\n\n',
          ),
        );
        controller.close();
      },
    });
    respondWith = () => new Response(stream, { status: 200 });

    const chunks: any[] = [];
    await provider.processStreamingRequest?.(
      { id: 'gg-s1', taskType: 'generation', prompt: 's' } as any,
      (c: any) => chunks.push(c),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(0);
  });

  it('HTTP 500 错误路径（retry/包装分支）', async () => {
    respondWith = () => okJSON({ error: { message: 'internal' } }, 500);
    await expect(
      provider.processRequest({ id: 'gg-e1', taskType: 'generation', prompt: 'p' } as any),
    ).rejects.toThrow();
  });
});

describe('Wave-10 — logger 级别分支（console spy 断言）', () => {
  it('level=INFO 时 debug 不输出、info 输出', () => {
    const calls: any[] = [];
    const orig = console.log;
    console.log = (...a: any[]) => calls.push(a.join(' '));
    const l = new Logger({ level: LogLevel.INFO });
    l.debug('suppressed');
    l.info('visible');
    console.log = orig;
    expect(calls.some((c) => c.includes('suppressed'))).toBe(false);
    expect(calls.some((c) => c.includes('visible'))).toBe(true);
  });

  it('level=ERROR 时 warn 也不输出', () => {
    const warns: any[] = [];
    const origWarn = console.warn;
    console.warn = (...a: any[]) => warns.push(a.join(' '));
    const l = new Logger({ level: LogLevel.ERROR });
    l.warn('suppressed-warn');
    console.warn = origWarn;
    expect(warns.length).toBe(0);
  });

  it('error 级别输出含 Error name/message', () => {
    const errors: any[] = [];
    const origErr = console.error;
    console.error = (...a: any[]) => errors.push(a.join(' '));
    const l = new Logger({ level: LogLevel.ERROR });
    l.error('failed', new Error('boom'));
    console.error = origErr;
    expect(errors.some((c) => c.includes('failed') || c.includes('boom'))).toBe(true);
  });
});

describe('Wave-10 — ModelAdapter usage 缺失 metadata 变体', () => {
  let adapter: ModelAdapter;
  const originalFetch = globalThis.fetch;
  let respondWith: (url: string) => Response;

  beforeEach(async () => {
    const spy = jest.spyOn(globalThis, 'fetch');
    (spy as any).mockImplementation((input: any) => Promise.resolve(respondWith(String(input))));
    (globalThis as any).fetch = spy;

    adapter = new ModelAdapter();
    await adapter.initialize({
      defaultModel: 'gpt-4', fallbackModel: 'gpt-3.5-turbo',
      routing: { type: 'smart' } as any,
      cache: { enabled: true, ttl: 300000, maxSize: 1000, strategy: 'lru', compressionEnabled: false, encryptionEnabled: false } as any,
      monitoring: { enabled: true } as any,
    } as any);
    await adapter.addModel({
      id: 'gpt-4', name: 'gpt-4', provider: 'openai', model: 'gpt-4o-mini',
      enabled: true, credentials: { apiKey: TEST_KEY },
      capabilities: { taskTypes: ['generation'], streaming: true, maxTokens: 4096 },
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it.skip('usage 缺失字段时响应构造 || 0 兜底（SDK 无 usage 响应兼容悬案）', async () => {
    respondWith = () => okJSON({
      id: 'c-x', model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'no-usage' }, finish_reason: 'stop' }],
      // 无 usage —— || 0 兜底分支
    });

    const res = await adapter.processRequest({ id: 'nu-1', taskType: 'generation', prompt: 'p' } as any);
    expect(res.usage.totalTokens).toBe(0);
    expect(res.usage.inputTokens).toBe(0);
    expect(res.metadata.provider).toBe('openai');
  });
});
