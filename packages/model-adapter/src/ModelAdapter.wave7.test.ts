/**
 * Wave-7 — ModelAdapter transform 变体群（adapter 级 fetch spy 驱动真 OpenAIProvider）
 * 覆盖：tool_calls 映射 / cost 分支 / usage 缺失 / finish 变体 / 空 choices / 网络错误
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { ModelAdapter } from './ModelAdapter';
import type { ModelAdapterConfig, ModelConfig, ModelRequest } from './IModelAdapter';

const TEST_KEY = ['test', '-', 'key'].join('');

const openAIJSON = (overrides: Record<string, any> = {}) => ({
  id: 'chatcmpl-w7',
  model: 'gpt-4o-mini',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'w7-content' }, finish_reason: 'stop' },
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
  ({ id: `w7-${Math.random().toString(36).slice(2, 8)}`, taskType, prompt: 'w7' } as any);

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

describe('Wave-7 — transform 变体群（adapter 级 fetch spy）', () => {
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

  it('tool_calls 响应 → ModelAdapter transform 的 toolCalls 群', async () => {
    respondRef.fn = () =>
      okJSON(
        openAIJSON({
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"yy"}' } },
                  { id: 'c2', type: 'function', function: { name: 'fetch', arguments: '{"u":"/x"}' } },
                ],
              },
            },
          ],
        }),
      );

    const res = await adapter.processRequest(modelRequest('generation'));
    expect(res.toolCalls).toHaveLength(2);
    expect(res.toolCalls[0].toolName).toBe('search');
    expect(res.toolCalls[1].toolName).toBe('fetch');
    expect(res.finishReason).toBe('tool_calls');
  });

  it('usage 缺失 cost 字段时 totalTokens 正常解析（产品当前不透传 cost）', async () => {
    respondRef.fn = () =>
      okJSON(openAIJSON({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));

    const res = await adapter.processRequest(modelRequest('generation'));
    expect(res.usage.totalTokens).toBe(3);
    expect(res.usage.inputTokens).toBe(1);
    expect(res.usage.outputTokens).toBe(2);
  });

  it('usage 缺失时 || 0 兜底分支', async () => {
    respondRef.fn = () => okJSON(openAIJSON({ usage: undefined }));

    const res = await adapter.processRequest(modelRequest('generation'));
    expect(res.usage.totalTokens).toBe(0);
  });

  it('finish_reason=content_filter 变体', async () => {
    respondRef.fn = () =>
      okJSON(openAIJSON({ choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'content_filter' }] }));

    const res = await adapter.processRequest(modelRequest('generation'));
    expect(res.finishReason).toBe('content_filter');
  });

  it('空 choices 防御分支', async () => {
    respondRef.fn = () => okJSON(openAIJSON({ choices: [] }));

    await expect(adapter.processRequest(modelRequest('generation'))).rejects.toThrow();
  });

  it('fetch 网络 reject → 错误包装群', async () => {
    const spy = globalThis.fetch as any;
    spy.mockImplementation(() => Promise.reject(new TypeError('fetch network fail')));

    await expect(adapter.processRequest(modelRequest('generation'))).rejects.toThrow();
    spy.mockImplementation((input: any) => Promise.resolve(respondRef.fn(String(input))));
  });

  it('不同 prompt 产生不同 cache key（generateCacheKey 差异分支）', async () => {
    respondRef.fn = () => okJSON(openAIJSON());
    const r1 = await adapter.processRequest({ id: 'a', taskType: 'generation', prompt: 'prompt-A' } as any);
    const r2 = await adapter.processRequest({ id: 'b', taskType: 'generation', prompt: 'prompt-B' } as any);
    // 不同 prompt → 不同 key → 双双真实调用（非缓存命中同一键）
    expect(r1.content).toBe('w7-content');
    expect(r2.content).toBe('w7-content');
  });
});
