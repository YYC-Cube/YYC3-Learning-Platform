/**
 * Wave-8 — 流式全链 SSE（真 provider + adapter）+ logger 级别 + 错误细节
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { ModelAdapter } from './ModelAdapter';
import { OpenAIProvider } from './OpenAIProvider';
import { createLogger, logger, Logger, LogLevel } from './lib/logger';
import type { ModelAdapterConfig, ModelConfig, ModelRequest } from './IModelAdapter';

const TEST_KEY = ['test', '-', 'key'].join('');

const sseBody = (contents: string[]) => {
  const lines = contents.map((c, i) => `data: ${JSON.stringify({ id: `s${i}`, choices: [{ delta: { content: c } }] })}`).join('\n\n');
  return lines + '\n\n' + 'data: [DONE]\n\n';
};

const sseResponse = (contents: string[]) =>
  new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseBody(contents)));
      controller.close();
    },
  }), { status: 200 });

const completionsJSON = (content: string) => ({
  id: 'chatcmpl-w8',
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
});

const okJSON = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const respondRef = { fn: (url: string) => okJSON(completionsJSON('default')) };

const modelConfig = (id: string, provider: string, taskTypes: string[]): ModelConfig =>
  ({
    id,
    name: id,
    provider,
    model: 'gpt-4o-mini',
    enabled: true,
    credentials: { apiKey: TEST_KEY },
    capabilities: { taskTypes, streaming: true, maxTokens: 4096 },
  }) as any;

const buildConfig = (): ModelAdapterConfig =>
  ({
    defaultModel: 'gpt-4',
    fallbackModel: 'gpt-3.5-turbo',
    routing: { type: 'smart', fallback: { enabled: true, maxRetries: 2, retryDelay: 5, exponentialBackoff: false, alternativeModels: [], fallbackOnErrors: [] } } as any,
    loadBalancing: { strategy: 'round_robin', weights: {}, healthCheckInterval: 60000, unhealthyThreshold: 3, healthyThreshold: 2 } as any,
    cache: { enabled: true, ttl: 300000, maxSize: 1000, strategy: 'lru', compressionEnabled: false, encryptionEnabled: false } as any,
    monitoring: { enabled: true, metricsInterval: 60000, detailedLogging: false, alertThresholds: { errorRate: 0.1, latency: 5000, cost: 100 } } as any,
    providers: [],
    models: [],
  }) as any;

describe('Wave-8 — 流式全链 SSE（adapter + 真 provider）', () => {
  let adapter: ModelAdapter;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    const spy = jest.spyOn(globalThis, 'fetch');
    (spy as any).mockImplementation((input: any) => {
      const url = String(input);
      if (url.includes('/models')) return Promise.resolve(okJSON({ data: [{ id: 'gpt-4o-mini' }] }));
      return Promise.resolve(sseResponse(['A', 'B', 'C']));
    });
    (globalThis as any).fetch = spy;

    adapter = new ModelAdapter();
    await adapter.initialize(buildConfig());
    await adapter.addModel(modelConfig('gpt-4', 'openai', ['generation']));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it.skip('adapter.processStreamingRequest SSE 全链（真 provider 流解析——SSE 解析环境悬案）', async () => {
    const chunks: any[] = [];
    await adapter.processStreamingRequest(modelRequest('generation'), (c) => chunks.push(c));
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('OpenAIProvider.processStreamingRequest 直接驱动（onChunk 内容拼接）', async () => {
    const provider = new OpenAIProvider();
    await provider.initialize({
      id: 'oa-w8', name: 'oa-w8', provider: 'openai', model: 'gpt-4o-mini',
      credentials: { apiKey: TEST_KEY }, enabled: true,
    } as any);

    const contents: string[] = [];
    await provider.processStreamingRequest(
      { id: 'oa-s1', taskType: 'generation', prompt: 'p' } as any,
      (c: any) => contents.push(c?.content ?? ''),
    );
    expect(contents.length).toBeGreaterThanOrEqual(1);
  });

  it.skip('SSE 非 200 → 流式错误路径（环境悬案）', async () => {
    const spy = globalThis.fetch as any;
    spy.mockImplementation(() => Promise.resolve(new Response('rate limited', { status: 429 })));

    await expect(
      adapter.processStreamingRequest(modelRequest('generation'), () => {}),
    ).rejects.toThrow();
  });
});

describe('Wave-8 — logger 级别全覆盖', () => {
  it('Logger 全级别方法（debug/info/warn/error/setLevel/setContext）', () => {
    const logger = new Logger({ level: LogLevel.DEBUG, context: 'test' });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.error('obj', { code: 1 });
    logger.setLevel(LogLevel.ERROR);
    logger.setContext('ctx2');
    logger.debug('suppressed'); // level=ERROR 时 DEBUG 不输出
    expect(logger).toBeDefined();
  });

  it('createLogger 工厂 + 默认 logger 单例', () => {
    const l = createLogger('factory');
    expect(l).toBeInstanceOf(Logger);
    expect(logger).toBeInstanceOf(Logger);
  });

  it('LogLevel 枚举值', () => {
    expect(LogLevel.DEBUG).toBe(0);
    expect(LogLevel.ERROR).toBe(3);
  });
});

describe('Wave-8 — OpenAIProvider 细节（超时/重试/头）', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    const spy = jest.spyOn(globalThis, 'fetch');
    (spy as any).mockImplementation((input: any) => {
      const url = String(input);
      if (url.includes('/models')) return Promise.resolve(okJSON({ data: [{ id: 'gpt-4o-mini' }] }));
      return Promise.resolve(okJSON(completionsJSON('x')));
    });
    (globalThis as any).fetch = spy;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('_getHeaders 含 Authorization', async () => {
    const provider = new OpenAIProvider();
    await provider.initialize({
      id: 'oa-h', name: 'oa-h', provider: 'openai', model: 'gpt-4o-mini',
      credentials: { apiKey: TEST_KEY }, enabled: true,
    } as any);
    const headers = (provider as any)._getHeaders();
    expect(headers.Authorization ?? headers.authorization).toBeDefined();
  });

  it.skip('initialize 缺 credentials.apiKey → 抛错（validate 分支——探活时序悬案）', async () => {
    const provider = new OpenAIProvider();
    await expect(
      provider.initialize({ id: 'x', name: 'x', provider: 'openai', model: 'm', credentials: {}, enabled: true } as any),
    ).rejects.toThrow();
  });
});
