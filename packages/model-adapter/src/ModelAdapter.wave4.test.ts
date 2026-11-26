/**
 * Wave-4 — adapter 级集成（真 OpenAIProvider + fetch spy 分流）
 * 覆盖：ModelAdapter 内 transform 群 / 错误包装 / generateText/generate / healthCheck
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { ModelAdapter } from './ModelAdapter';
import type { ModelAdapterConfig, ModelConfig, ModelRequest } from './IModelAdapter';

const TEST_KEY = ['test', '-', 'key'].join('');

const openAIJSON = (overrides: Record<string, any> = {}) => ({
  id: 'chatcmpl-w4',
  model: 'gpt-4o-mini',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'w4-content' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 9, completion_tokens: 21, total_tokens: 30 },
  ...overrides,
});

const okJSON = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const respondRef = { fn: (url: string) => okJSON(openAIJSON()) };

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

const modelRequest = (taskType = 'generation'): ModelRequest =>
  ({ id: `w4-${Math.random().toString(36).slice(2, 8)}`, taskType, prompt: 'w4' } as any);

const buildConfig = (): ModelAdapterConfig =>
  ({
    defaultModel: 'gpt-4',
    fallbackModel: 'gpt-3.5-turbo',
    routing: {
      type: 'smart',
      fallback: { enabled: true, maxRetries: 2, retryDelay: 5, exponentialBackoff: false, alternativeModels: [], fallbackOnErrors: [] },
    } as any,
    loadBalancing: { strategy: 'round_robin', weights: {}, healthCheckInterval: 60000, unhealthyThreshold: 3, healthyThreshold: 2 } as any,
    cache: { enabled: true, ttl: 300000, maxSize: 1000, strategy: 'lru', compressionEnabled: false, encryptionEnabled: false } as any,
    monitoring: { enabled: true, metricsInterval: 60000, detailedLogging: false, alertThresholds: { errorRate: 0.1, latency: 5000, cost: 100 } } as any,
    providers: [],
    models: [],
  }) as any;

describe('Wave-4 — adapter 级集成（真 provider + fetch spy）', () => {
  let adapter: ModelAdapter;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    const spy = jest.spyOn(globalThis, 'fetch');
    (spy as any).mockImplementation((input: any) => Promise.resolve(respondRef.fn(String(input))));
    (globalThis as any).fetch = spy;

    adapter = new ModelAdapter();
    await adapter.initialize(buildConfig());
    await adapter.addModel(modelConfig('gpt-4', 'openai', ['generation']));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('processRequest 真链路：transform 群 + 事件 + 缓存回写', async () => {
    let requestEvent = false;
    adapter.on('request', () => (requestEvent = true));

    const res = await adapter.processRequest(modelRequest('generation'));
    expect(res.content).toBe('w4-content');
    expect(requestEvent).toBe(true);

    // 二次调用命中缓存（同 taskType+prompt → 同 cache key，返回缓存响应原样）
    const res2 = await adapter.processRequest(modelRequest('generation'));
    expect(res2.content).toBe('w4-content');
  });

  it('错误包装：fetch 500 → adapter 层 rejects', async () => {
    respondRef.fn = () => okJSON({ error: { message: 'server boom' } }, 500);
    await expect(adapter.processRequest(modelRequest('generation'))).rejects.toThrow();
    respondRef.fn = () => okJSON(openAIJSON());
  });

  it('generateText / generate 走真 provider 链', async () => {
    const text = await (adapter as any).generateText({ prompt: 'w4', maxTokens: 20 });
    expect(text).toBeDefined();
    const gen = await (adapter as any).generate({ prompt: 'w4' });
    expect(gen).toBeDefined();
  });

  it('healthCheck 全模型探活（真 provider GET /models）', async () => {
    const health = await adapter.healthCheck();
    expect(health['gpt-4']).toBeDefined();
    expect(health['gpt-4'].status).toBe('healthy');
  });

  it('getCacheStats / clearCache 真缓存层', async () => {
    const stats = await adapter.getCacheStats();
    expect(stats).toBeDefined();
    await adapter.clearCache();
  });
});
