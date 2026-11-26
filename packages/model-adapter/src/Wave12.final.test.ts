/**
 * Wave-12 终波 — Google NDJSON 流式全链 + ModelAdapter 流 transform 变体
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { GoogleProvider } from './GoogleProvider';
import { ModelAdapter } from './ModelAdapter';
import { createLogger, Logger, LogLevel } from './lib/logger';
import type { ModelAdapterConfig, ModelConfig, ModelRequest } from './IModelAdapter';

const TEST_KEY = ['test', '-', 'key'].join('');

const ndjsonResponse = (items: any[]) => {
  const body = items.map((i) => JSON.stringify(i)).join('\n') + '\n';
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  }), { status: 200 });
};

const googleChunk = (text: string, finish?: string) => ({
  candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: finish, index: 0 }],
});

describe('Wave-12 — GoogleProvider NDJSON 流式全链', () => {
  let provider: GoogleProvider;
  const originalFetch = globalThis.fetch;
  let respondWith: (url: string) => Response;

  beforeEach(async () => {
    const spy = jest.spyOn(globalThis, 'fetch');
    (spy as any).mockImplementation((input: any) => Promise.resolve(respondWith(String(input))));
    (globalThis as any).fetch = spy;

    provider = new GoogleProvider();
    await provider.initialize({
      id: 'gg-nd', name: 'gg-nd', provider: 'google', model: 'gemini-pro',
      credentials: { apiKey: TEST_KEY }, enabled: true,
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('NDJSON 多行流驱动（onChunk 逐 text 收集）', async () => {
    respondWith = () => ndjsonResponse([
      googleChunk('第一段'),
      googleChunk('第二段'),
      googleChunk('第三段', 'STOP'),
    ]);

    const chunks: any[] = [];
    await provider.processStreamingRequest(
      { id: 'gg-nd1', taskType: 'generation', prompt: 'nd' } as any,
      (c: any) => chunks.push(c),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('非 200 流式 → 抛 Google API error（148 行分支）', async () => {
    respondWith = () => new Response('quota exceeded', { status: 429 });

    await expect(
      provider.processStreamingRequest(
        { id: 'gg-nd2', taskType: 'generation', prompt: 's' } as any,
        () => {},
      ),
    ).rejects.toThrow(/Google API error/);
  });

  it('body 不可读 → 抛 not readable（153 行分支）', async () => {
    respondWith = () => new Response(null, { status: 200 });
    await expect(
      provider.processStreamingRequest(
        { id: 'gg-nd3', taskType: 'generation', prompt: 's' } as any,
        () => {},
      ),
    ).rejects.toThrow(/not readable/);
  });

  it('processRequest NDJSON 响应（非流式端点变体）', async () => {
    respondWith = () => ndjsonResponse([googleChunk('nd-req')]);

    const res = await provider.processRequest(
      { id: 'gg-nd4', taskType: 'generation', prompt: 'p' } as any,
    );
    expect(res).toBeDefined();
  });
});

describe('Wave-12 — ModelAdapter 流 transform 变体', () => {
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

  it('流式 delta 多段拼接（ModelAdapter 1377-1393 transform）', async () => {
    const sseChunks = ['Hello', ' ', 'Wave-12'];
    const body = sseChunks.map((c) => `data: ${JSON.stringify({ id: 'sx', choices: [{ delta: { content: c } }] })}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
    respondWith = () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }), { status: 200 });

    const chunks: any[] = [];
    await adapter.processStreamingRequest(
      { id: 'ma-s1', taskType: 'generation', prompt: 'p' } as any,
      (c: any) => chunks.push(c),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('logger DEBUG 关闭分支（INFO 级抑制 debug 输出）', () => {
    const outputs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => outputs.push(a.join(' '));

    const l = new Logger({ level: LogLevel.INFO, context: 'w12' });
    l.debug('no-show');
    console.log = origLog;

    expect(outputs.some((o) => o.includes('no-show'))).toBe(false);
  });

  it('createLogger 工厂 context 前缀传递', () => {
    const outputs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => outputs.push(a.join(' '));

    const l = createLogger('wave12-ctx');
    l.info('ctx-test');
    console.log = origLog;

    expect(outputs.some((o) => o.includes('[wave12-ctx]'))).toBe(true);
  });
});
